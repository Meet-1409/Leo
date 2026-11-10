"""Interview voice that stays in AWS Mumbai: Transcribe hears, Bedrock thinks, Polly speaks.

The server sends the call page the same events it already handles for the OpenAI route.
"""

import asyncio
import logging
import os
import re
import time
from functools import lru_cache
from typing import Callable, Optional

log = logging.getLogger("leo")

REGION = "ap-south-1"
TURN_SILENCE_SECONDS = 0.8  # After Transcribe finishes a sentence.
PARTIAL_SILENCE_SECONDS = 1.5  # If it never reports a finished sentence.
TRANSCRIBE_USD_PER_MINUTE = 0.024
POLLY_USD_PER_CHAR = 16 / 1_000_000
BEDROCK_USD_PER_TOKEN = {"input": 0.25 / 1_000_000, "output": 1.25 / 1_000_000}
LANGUAGES = {"English": "en-IN", "Hindi": "hi-IN"}
SENTENCE_END = re.compile(r"(?<=[.!?।])\s+")
END_TOOL = {"toolSpec": {"name": "end_interview", "description": "Ends the call. Use only as your rules describe.", "inputSchema": {"json": {
    "type": "object", "properties": {"reason": {"type": "string", "enum": ["abuse", "non_cooperation", "candidate_request", "time_up"]}}, "required": ["reason"]}}}}


def model_id() -> str:
    value = os.getenv("BEDROCK_MODEL_ID", "mistral.ministral-3-8b-instruct")
    # Cross-region profiles can process data outside India.
    if value.split(".")[0] in ("apac", "global", "us", "eu"):
        raise RuntimeError("BEDROCK_MODEL_ID must be a model that runs in Mumbai, not a cross-region profile")
    return value


@lru_cache(maxsize=None)
def aws_client(service: str):
    # Building a client is slow, so reusing one saves time on every sentence.
    import boto3
    return boto3.client(service, region_name=REGION)


def scoring_model_id() -> str:
    # Grading needs a stronger model than the live conversation. Mumbai only, as above.
    value = os.getenv("BEDROCK_SCORING_MODEL_ID", "deepseek.v3.2")
    if value.split(".")[0] in ("apac", "global", "us", "eu"):
        raise RuntimeError("BEDROCK_SCORING_MODEL_ID must be a model that runs in Mumbai")
    return value


def bedrock():
    return aws_client("bedrock-runtime")


class AwsServices:
    def __init__(self, language: str):
        self.language = LANGUAGES.get(language, "en-IN")
        self.stream = None

    async def transcribe(self, on_text: Callable[[str, bool], None]) -> None:
        from amazon_transcribe.client import TranscribeStreamingClient
        from amazon_transcribe.handlers import TranscriptResultStreamHandler

        class Handler(TranscriptResultStreamHandler):
            async def handle_transcript_event(self, event):
                for result in event.transcript.results:
                    if result.alternatives:
                        on_text(result.alternatives[0].transcript, not result.is_partial)

        client = TranscribeStreamingClient(region=REGION)
        self.stream = await client.start_stream_transcription(language_code=self.language, media_sample_rate_hz=16000, media_encoding="pcm",
                                                                   enable_partial_results_stabilization=True, partial_results_stability="medium")
        await Handler(self.stream.output_stream).handle_events()

    async def send_audio(self, chunk: bytes) -> None:
        if self.stream:
            await self.stream.input_stream.send_audio_event(audio_chunk=chunk)

    async def stop(self) -> None:
        if self.stream:
            await self.stream.input_stream.end_stream()

    def generate(self, system: str, messages: list, allow_tool: bool):
        """Yields ("text", delta), ("tool", {"name", "arguments"}) and ("usage", dict)."""
        args = {"modelId": model_id(), "system": [{"text": system}], "messages": messages, "inferenceConfig": {"maxTokens": 300, "temperature": 0.5}}
        if allow_tool:
            args["toolConfig"] = {"tools": [END_TOOL]}
        tool_input, tool_name = "", ""
        for event in bedrock().converse_stream(**args)["stream"]:
            if "contentBlockStart" in event and "toolUse" in event["contentBlockStart"]["start"]:
                tool_name = event["contentBlockStart"]["start"]["toolUse"]["name"]
            elif "contentBlockDelta" in event:
                delta = event["contentBlockDelta"]["delta"]
                if "text" in delta:
                    yield "text", delta["text"]
                elif "toolUse" in delta:
                    tool_input += delta["toolUse"].get("input", "")
            elif "metadata" in event:
                yield "usage", event["metadata"].get("usage", {})
        if tool_name:
            yield "tool", {"name": tool_name, "arguments": tool_input}

    def speak(self, text: str) -> bytes:
        reply = aws_client("polly").synthesize_speech(
            Text=text, VoiceId="Kajal", Engine="neural", LanguageCode=self.language, OutputFormat="pcm", SampleRate="16000")
        return reply["AudioStream"].read()


class VoiceCall:
    def __init__(self, system: str, closing_system: str, previous: list, send_json, send_bytes, services):
        self.system, self.closing_system = system, closing_system
        self.turns = [dict(t) for t in previous]
        self.send_json, self.send_bytes, self.services = send_json, send_bytes, services
        self.wrap_up = False
        self.next_id = 0
        self.heard_item: Optional[str] = None
        self.heard_final, self.heard_partial = "", ""
        self.silence_task: Optional[asyncio.Task] = None
        self.reply_task: Optional[asyncio.Task] = None
        self.cancelled = False
        self.audio_bytes = self.chars = self.tokens_in = self.tokens_out = 0

    def cost_usd(self) -> float:
        return (self.audio_bytes / 32000 / 60 * TRANSCRIBE_USD_PER_MINUTE + self.chars * POLLY_USD_PER_CHAR
                + self.tokens_in * BEDROCK_USD_PER_TOKEN["input"] + self.tokens_out * BEDROCK_USD_PER_TOKEN["output"])

    def new_id(self, prefix: str) -> str:
        self.next_id += 1
        return f"{prefix}{self.next_id}"

    def messages(self) -> list:
        out = []
        for turn in self.turns:
            role = "user" if turn["speaker"] == "candidate" else "assistant"
            text = turn["text"] or "[not transcribed]"
            if out and out[-1]["role"] == role:
                out[-1]["content"][0]["text"] += " " + text
            else:
                out.append({"role": role, "content": [{"text": text}]})
        if not out or out[-1]["role"] == "assistant":
            out.append({"role": "user", "content": [{"text": "[The candidate is waiting. Continue the interview.]"}]})
        if out[0]["role"] != "user":
            out.insert(0, {"role": "user", "content": [{"text": "[The interview has started.]"}]})
        return out

    def on_text(self, text: str, final: bool) -> None:
        asyncio.get_running_loop().create_task(self.heard(text, final))

    async def heard(self, text: str, final: bool) -> None:
        if not text.strip():
            return
        if self.heard_item is None:
            self.heard_item = self.new_id("c")
            await self.send_json({"type": "conversation.item.added", "item": {"id": self.heard_item, "role": "user"}})
            await self.send_json({"type": "input_audio_buffer.speech_started"})
        if final:
            self.heard_final = f"{self.heard_final} {text}".strip()
            self.heard_partial = ""
        else:
            self.heard_partial = text
        await self.send_json({"type": "leo.partial", "item_id": self.heard_item, "text": f"{self.heard_final} {self.heard_partial}".strip()})
        if self.silence_task:
            self.silence_task.cancel()
        self.silence_task = asyncio.get_running_loop().create_task(self.end_turn_after_silence(TURN_SILENCE_SECONDS if final else PARTIAL_SILENCE_SECONDS))

    async def end_turn_after_silence(self, seconds: float) -> None:
        await asyncio.sleep(seconds)
        await self.commit_turn()

    async def commit_turn(self) -> None:
        if self.heard_item is None:
            return
        item, text = self.heard_item, f"{self.heard_final} {self.heard_partial}".strip()
        self.heard_item, self.heard_final, self.heard_partial = None, "", ""
        self.turns.append({"speaker": "candidate", "text": text})
        await self.send_json({"type": "input_audio_buffer.speech_stopped"})
        await self.send_json({"type": "conversation.item.input_audio_transcription.completed", "item_id": item, "transcript": text})

    async def control(self, message: dict) -> None:
        kind = message.get("type")
        if kind == "response.create" and not (self.reply_task and not self.reply_task.done()):
            # The browser is not trusted to write instructions, so only the choice of reply is read.
            wanted = str((message.get("response") or {}).get("instructions") or "")
            mode = "repeat" if wanted.startswith("The candidate could not hear") else "closing" if wanted.startswith("Say one short") else ""
            self.reply_task = asyncio.get_running_loop().create_task(self.reply(mode))
        elif kind == "response.cancel":
            self.cancelled = True
        elif kind == "session.update":
            self.wrap_up = True
        elif kind == "input_audio_buffer.commit":
            await self.commit_turn()

    def plan(self, mode: str):
        if mode == "repeat":
            return self.system + "\n\nThe candidate could not hear you. Repeat your last question exactly, and say nothing else.", False
        if mode == "closing":
            return self.system + "\n\nSay one short, neutral closing sentence. Do not say whether the candidate passed.", False
        return (self.closing_system if self.wrap_up else self.system), True

    async def reply(self, mode: str) -> None:
        self.cancelled = False
        self.reply_started = time.monotonic()
        self.first_audio_logged = False
        item = self.new_id("a")
        await self.send_json({"type": "response.created"})
        await self.send_json({"type": "conversation.item.added", "item": {"id": item, "role": "assistant"}})
        system, allow_tool = self.plan(mode)
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def worker():
            try:
                for part in self.services.generate(system, self.messages(), allow_tool):
                    loop.call_soon_threadsafe(queue.put_nowait, part)
            except Exception as error:
                log.error("Bedrock failed: %s", type(error).__name__)
            loop.call_soon_threadsafe(queue.put_nowait, None)

        loop.run_in_executor(None, worker)
        said, pending, tool = "", "", None
        while True:
            part = await queue.get()
            if part is None or self.cancelled:
                break
            kind, value = part
            if kind == "tool":
                tool = value
            elif kind == "usage":
                self.tokens_in += value.get("inputTokens", 0)
                self.tokens_out += value.get("outputTokens", 0)
            else:
                pending += value
                pieces = SENTENCE_END.split(pending)
                for sentence in pieces[:-1]:
                    said = await self.say(item, said, sentence)
                pending = pieces[-1]
        if pending.strip() and not self.cancelled:
            said = await self.say(item, said, pending)
        if said:
            self.turns.append({"speaker": "interviewer", "text": said})
        output = [{"type": "message", "id": item, "content": [{"transcript": said}]}] if said else []
        if tool and not self.cancelled:
            output.append({"type": "function_call", "name": tool["name"], "arguments": tool["arguments"]})
        await self.send_json({"type": "response.done", "response": {"output": output}})

    async def say(self, item: str, said: str, sentence: str) -> str:
        sentence = sentence.strip()
        if not sentence:
            return said
        self.chars += len(sentence)
        try:
            audio = await asyncio.get_running_loop().run_in_executor(None, self.services.speak, sentence)
        except Exception as error:
            log.error("Polly failed: %s", type(error).__name__)
            audio = b""
        if self.cancelled:
            return said
        said = f"{said} {sentence}".strip()
        await self.send_json({"type": "response.output_audio_transcript.delta", "item_id": item, "delta": sentence + " "})
        if audio:
            if not self.first_audio_logged:
                self.first_audio_logged = True
                log.info("Voice reply: first audio after %.2fs", time.monotonic() - self.reply_started)
            await self.send_bytes(audio)
        return said


def complete_text(system: str, user: str, max_tokens: int = 1500) -> str:
    reply = bedrock().converse(modelId=model_id(), system=[{"text": system}], messages=[{"role": "user", "content": [{"text": user}]}],
                               inferenceConfig={"maxTokens": max_tokens})
    return "".join(b.get("text", "") for b in reply["output"]["message"]["content"]).strip()


def complete_json(system: str, user: str, schema: dict):
    tool = {"toolSpec": {"name": "save_report", "description": "Saves the report.", "inputSchema": {"json": schema}}}
    reply = bedrock().converse(modelId=scoring_model_id(), system=[{"text": system}], messages=[{"role": "user", "content": [{"text": user}]}],
                               inferenceConfig={"maxTokens": 8000}, toolConfig={"tools": [tool], "toolChoice": {"tool": {"name": "save_report"}}})
    for block in reply["output"]["message"]["content"]:
        if "toolUse" in block:
            usage = reply.get("usage", {})
            return block["toolUse"]["input"], {"prompt_tokens": usage.get("inputTokens", 0), "completion_tokens": usage.get("outputTokens", 0)}
    raise RuntimeError("Bedrock returned no report")
