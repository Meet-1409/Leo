"""End to end checks through the real web routes. OpenAI is replaced, so these cost nothing."""
import asyncio
import json
import os
import re
import sys
from pathlib import Path

import tempfile
os.environ["DATABASE_URL"] = os.getenv("LEO_TEST_DB") or "sqlite:///" + tempfile.mkdtemp() + "/test.db"
os.environ["OPENAI_API_KEY"] = "sk-FAKE123"
os.environ["BUDGET_USD"] = "2.5"
os.environ["MAX_CALLS_PER_HOUR"] = "1000"
os.environ["LEO_SECRET"] = "test-secret"
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from app import interview as iv, main  # noqa: E402
from app.db import Interview, Job, Org, Outbox, SessionLocal, User  # noqa: E402

# Keep uploaded test files away from the developer's real local data.
TEST_FILES = Path(tempfile.mkdtemp(prefix="leo-test-files-"))
for attribute in ("RECORDINGS", "RESUMES", "LOGOS", "PHOTOS"):
    directory = TEST_FILES / attribute.lower()
    directory.mkdir()
    setattr(main, attribute, directory)

REPORT = {"candidateLabel": "Candidate", "interviewerLabel": "Interviewer", "overallScore": 80, "communicationScore": 70, "technicalScore": 75,
          "cultureFitScore": None, "languageScore": 70, "summary": "Good.", "strengths": ["Clear"], "weaknesses": ["a", "b", "c"], "recommendations": ["d"],
          "conduct": "none", "conductNotes": "", "qnaEvaluations": [{"question": "Q", "candidateAnswer": "A", "idealAnswer": "I", "score": 80, "feedback": "F"}]}
USAGE = {"input_token_details": {"audio_tokens": 1000, "text_tokens": 500}, "output_token_details": {"audio_tokens": 1000, "text_tokens": 100}}
sent_sessions = []


class FakeReply:
    is_success = True
    status_code = 201
    text = "v=0 answer"
    headers = {"Location": "/v1/realtime/calls/rtc_fake"}


async def fake_call(offer, item):
    sent_sessions.append(iv.session_config(item))
    return FakeReply()


async def fake_score(item, turns):
    return dict(REPORT), {"prompt_tokens": 1000, "completion_tokens": 500}


async def fake_hang_up(call_id):
    return None


async def fake_limit(*args, **kwargs):
    return None


@pytest.fixture(scope="module")
def web():
    main.create_realtime_call = fake_call
    iv.score_transcript = fake_score
    iv.hang_up = fake_hang_up
    iv.enforce_limit = fake_limit
    with TestClient(main.app, follow_redirects=False, base_url="http://testserver") as client:
        yield client


def login(web, email, intent="hire"):
    web.cookies.clear()
    main.login_attempts.clear()
    page = web.post("/login/code", data={"email": email, "intent": intent})
    assert page.status_code == 200
    code = re.search(r'id="demo-code">(\d{6})', page.text).group(1)
    done = web.post("/login/verify", data={"email": email, "code": code, "intent": intent})
    assert done.status_code == 303
    return done.headers["location"]


def invite(web, job_id, email):
    assert web.post(f"/org/jobs/{job_id}/invite", data={"emails": email}).status_code == 303
    with SessionLocal() as db:
        item = db.query(Interview).filter_by(job_id=job_id, candidate_email=email).order_by(Interview.id.desc()).first()
        return item.id, main.token_for(item)


def org_credits():
    with SessionLocal() as db:
        return db.query(Org).filter_by(name="Sample Company").one().credits


def backend_job():
    with SessionLocal() as db:
        return db.query(Job).filter_by(title="Backend Engineer").one().id


def test_every_public_page_and_link_works(web):
    web.cookies.clear()
    seen, queue = set(), ["/"]
    while queue:
        url = queue.pop()
        if url in seen:
            continue
        seen.add(url)
        page = web.get(url)
        assert page.status_code == 200, url
        assert "Meleys" not in page.text and "MELEYS" not in page.text, url
        assert "{{" not in page.text and 'href="#"' not in page.text, url
        for link in re.findall(r'href="(/[^"#]*)"', page.text):
            if not link.startswith("/static") and "login" not in link:
                queue.append(link.split("?")[0])
    assert {"/", "/jobs", "/pricing", "/faq", "/contact", "/about", "/privacy", "/terms", "/support", "/demo", "/affiliate"} <= seen
    assert web.get("/nothing-here").status_code == 404


def test_login_rejects_wrong_codes_and_locks(web):
    web.cookies.clear()
    main.login_attempts.clear()
    page = web.post("/login/code", data={"email": "lock@leo.test", "intent": "interview"})
    assert 'id="demo-code"' in page.text
    for _ in range(5):
        assert web.post("/login/verify", data={"email": "lock@leo.test", "code": "000000"}).status_code == 400
    code = re.search(r'id="demo-code">(\d{6})', page.text).group(1)
    assert web.post("/login/verify", data={"email": "lock@leo.test", "code": code}).status_code == 400
    assert web.get("/org").status_code == 303


def test_code_requests_are_limited(web):
    web.cookies.clear()
    main.login_attempts.clear()
    results = [web.post("/login/code", data={"email": "many@leo.test"}).status_code for _ in range(6)]
    assert results[:5] == [200] * 5 and results[5] == 429


def test_other_site_form_is_refused(web):
    assert web.post("/logout", headers={"Origin": "https://evil.example"}).status_code == 403


def test_pages_need_login_and_right_role(web):
    web.cookies.clear()
    for url in ["/org", "/org/jobs", "/me"]:
        assert "/login" in web.get(url).headers["location"]
    login(web, "candidate@leo.test", "interview")
    assert web.get("/org").headers["location"] == "/org/new"


@pytest.mark.parametrize("email,urls", [
    ("org@leo.test", ["/org", "/org/jobs", "/org/jobs/new", "/org/candidates", "/org/reports", "/org/team", "/org/billing", "/org/support", "/org/list"]),
    ("candidate@leo.test", ["/me", "/me/profile", "/me/practice", "/me/history", "/me/certs", "/me/wallet", "/me/support"]),
])
def test_signed_in_pages_load(web, email, urls):
    login(web, email)
    for url in urls:
        page = web.get(url)
        assert page.status_code == 200, url
        assert 'href="#"' not in page.text and "Meleys" not in page.text, url


def test_sample_report_shows_scores_and_answers(web):
    login(web, "org@leo.test")
    with SessionLocal() as db:
        item = db.query(Interview).filter_by(candidate_name="Sample Candidate A").one()
    page = web.get(f"/org/report/{item.id}")
    assert "Clear on concepts" in page.text and "A strong answer" in page.text and "Their answer" in page.text


def test_org_cannot_see_another_orgs_data(web):
    with SessionLocal() as db:
        sample = db.query(Interview).filter_by(candidate_name="Sample Candidate A").one().id
    login(web, "other@leo.test")
    assert web.post("/org/new", data={"name": "Other Org"}).status_code == 303
    assert web.get(f"/org/report/{sample}").status_code == 404
    assert web.get(f"/org/jobs/{backend_job()}").status_code == 404
    assert web.post(f"/org/jobs/{backend_job()}/invite", data={"emails": "x@leo.test"}).status_code == 404


def test_job_description_shapes_the_interview_end_to_end(web):
    login(web, "org@leo.test")
    made = web.post("/org/jobs/new", data={"title": "Kafka Specialist", "description": "Run Kafka clusters for payments.", "skills": "Kafka", "exp_from": 5, "exp_to": 8,
                                           "minutes": 5, "action": "publish"})
    job_id = int(made.headers["location"].split("/")[-1])
    before = org_credits()
    item_id, token = invite(web, job_id, "kafka@leo.test")
    assert org_credits() == before - 25
    with SessionLocal() as db:
        assert token in db.query(Outbox).filter_by(to_email="kafka@leo.test").one().body
    web.cookies.clear()
    assert web.get(f"/i/{token}").status_code == 200
    lobby = web.get(f"/i/{token}/check")
    assert lobby.status_code == 200
    assert "go to OpenAI, outside India" in lobby.text
    assert 'id="interviewer-state"' in lobby.text
    assert web.get(f"/i/{token}/config").json()["record"] is True
    assert web.post(f"/i/{token}/session", content="v=0", headers={"content-type": "text/plain"}).status_code == 415
    reply = web.post(f"/i/{token}/session", content="v=0 offer", headers={"content-type": "application/sdp"})
    assert reply.status_code == 200 and reply.headers["x-time-limit-seconds"] == "300"
    prompt = sent_sessions[-1]["instructions"]
    assert "Kafka Specialist" in prompt and "Run Kafka clusters" in prompt and "5 to 8 years" in prompt
    second = web.post(f"/i/{token}/session", content="v=0 offer", headers={"content-type": "application/sdp"})
    assert second.status_code == 409
    finish = web.post(f"/i/{token}/finish", json={"usage": USAGE, "transcription_seconds": 60, "end_reason": "time_up",
                                                  "transcript": [{"speaker": "interviewer", "text": "Why Kafka?"}, {"speaker": "candidate", "text": "Ordering."}, {"speaker": "hacker", "text": "x"}],
                                                  "proctoring": [{"type": "tab_switch", "at_seconds": 9}, {"type": "made_up"}]})
    assert finish.status_code == 200
    assert web.post(f"/i/{token}/finish", json={"end_reason": "time_up"}).status_code == 409
    asyncio.run(asyncio.sleep(0))
    web.get("/health")
    for _ in range(50):
        if web.get(f"/i/{token}/status").json()["status"] == "finished":
            break
    assert web.post(f"/i/{token}/recording", content=b"\x00\x01", headers={"content-type": "video/webm"}).status_code == 200
    login(web, "org@leo.test")
    with SessionLocal() as db:
        item = db.get(Interview, item_id)
        assert [t["speaker"] for t in item.transcript] == ["interviewer", "candidate"]
        assert item.proctoring == [{"type": "tab_switch", "at_seconds": 9}]
        assert item.cost_usd > 0
    assert web.get(f"/org/interviews/{item_id}/recording").status_code == 200
    web.cookies.clear()
    assert web.get(f"/org/interviews/{item_id}/recording").status_code == 303
    (main.RECORDINGS / f"{item_id}.webm").unlink()


def test_bad_links_and_tampered_tokens_are_refused(web):
    web.cookies.clear()
    assert web.get("/i/nothing").status_code == 404
    with SessionLocal() as db:
        item = db.query(Interview).first()
        good = main.token_for(item)
    assert web.get(f"/i/{good[:-3]}abc").status_code == 404


def test_not_enough_credits_blocks_invites_and_cancel_refunds(web):
    login(web, "org@leo.test")
    job = backend_job()
    before = org_credits()
    item_id, _ = invite(web, job, "refund@leo.test")
    assert org_credits() == before - 50
    web.post(f"/org/interviews/{item_id}/cancel")
    assert org_credits() == before
    with SessionLocal() as db:
        db.query(Org).filter_by(name="Sample Company").update({"credits": 10})
        db.commit()
    reply = web.post(f"/org/jobs/{job}/invite", data={"emails": "poor@leo.test"})
    assert "not%20enough%20credits" in reply.headers["location"]
    with SessionLocal() as db:
        db.query(Org).filter_by(name="Sample Company").update({"credits": before})
        db.commit()


def test_never_connected_call_can_be_retried(web):
    login(web, "org@leo.test")
    _, token = invite(web, backend_job(), "retry@leo.test")
    web.post(f"/i/{token}/session", content="v=0", headers={"content-type": "application/sdp"})
    assert web.post(f"/i/{token}/finish", json={"end_reason": "connection_lost", "transcript": []}).json() == {"retry": True}
    assert web.get(f"/i/{token}/config").json()["limit_problem"] == ""


def test_budget_limit_refuses_new_calls(web):
    login(web, "org@leo.test")
    _, token = invite(web, backend_job(), "budget@leo.test")
    with SessionLocal() as db:
        extra = Interview(kind="practice", access_hash="spent", title="x", cost_usd=2.4, status="finished")
        db.add(extra)
        db.commit()
        extra_id = extra.id
    assert web.post(f"/i/{token}/session", content="v=0", headers={"content-type": "application/sdp"}).status_code == 429
    with SessionLocal() as db:
        db.delete(db.get(Interview, extra_id))
        db.commit()


def test_false_usage_cannot_hide_cost(web):
    login(web, "org@leo.test")
    item_id, token = invite(web, backend_job(), "cheat@leo.test")
    web.post(f"/i/{token}/session", content="v=0", headers={"content-type": "application/sdp"})
    iv.live_calls[item_id]["started"] -= 600
    web.post(f"/i/{token}/finish", json={"usage": {}, "end_reason": "time_up", "transcript": [{"speaker": "candidate", "text": "hi"}]})
    with SessionLocal() as db:
        assert db.get(Interview, item_id).cost_usd >= 0.17


def test_viewer_cannot_change_anything(web):
    login(web, "org@leo.test")
    web.post("/org/team/invite", data={"email": "viewer@leo.test", "role": "viewer"})
    login(web, "viewer@leo.test")
    assert web.get("/org").status_code == 200
    assert web.post("/org/jobs/new", data={"title": "x", "description": "y"}).status_code == 403
    assert web.post(f"/org/jobs/{backend_job()}/invite", data={"emails": "z@leo.test"}).status_code == 403
    assert web.post("/org/billing/buy", data={"pack": "500"}).status_code == 403


def test_candidate_practice_certificate_wallet_and_apply(web):
    login(web, "candidate@leo.test", "interview")
    start = web.post("/me/certs/python")
    token = start.headers["location"].split("/")[-1]
    with SessionLocal() as db:
        assert db.query(User).filter_by(email="candidate@leo.test").one().credits == 50
    assert web.get(f"/i/{token}/config").json()["record"] is False
    web.post(f"/i/{token}/session", content="v=0", headers={"content-type": "application/sdp"})
    web.post(f"/i/{token}/finish", json={"usage": USAGE, "end_reason": "time_up", "transcript": [{"speaker": "candidate", "text": "Lists are mutable."}]})
    for _ in range(50):
        if web.get(f"/i/{token}/status").json()["status"] == "finished":
            break
    assert "Python fundamentals" in web.get("/me/certs").text
    web.post("/me/wallet/buy", data={"pack": "100"})
    assert "Test purchase" in web.get("/me/wallet").text
    practice = web.post("/me/practice", data={"title": "Data Engineer", "minutes": "5"})
    assert practice.status_code == 303 and "/i/" in practice.headers["location"]
    job = backend_job()
    assert web.post(f"/jobs/{job}/apply").status_code == 303
    assert "Applied" in web.get(f"/jobs/{job}").text
    with SessionLocal() as db:
        others = db.query(Interview).filter_by(candidate_name="Sample Candidate A").one().id
    assert web.get(f"/me/report/{others}").status_code == 404


def test_hidden_admin_login(web):
    web.cookies.clear()
    main.login_attempts.clear()
    assert web.get("/backstage").status_code == 404
    assert web.post("/backstage/code", data={"email": "stranger@leo.test"}).json() == {"ok": True, "shown_code": ""}
    assert web.post("/backstage/verify", data={"email": "stranger@leo.test", "code": "123456"}).status_code == 400
    code = web.post("/backstage/code", data={"email": "admin@leo.test"}).json()["shown_code"]
    assert web.post("/backstage/verify", data={"email": "admin@leo.test", "code": "000000"}).status_code == 400
    assert web.post("/backstage/verify", data={"email": "admin@leo.test", "code": code}).json()["next"] == "/backstage"
    assert web.get("/backstage").status_code == 200
    web.cookies.clear()
    assert web.get("/backstage").status_code == 404


def test_login_never_gives_admin_access(web):
    login(web, "org@leo.test")
    assert web.get("/backstage").status_code == 404


def test_org_suspension_blocks_access(web):
    login(web, "org@leo.test")
    with SessionLocal() as db:
        db.query(Org).filter_by(name="Sample Company").update({"active": False})
        db.commit()
    assert web.get("/org").status_code == 403
    with SessionLocal() as db:
        db.query(Org).filter_by(name="Sample Company").update({"active": True})
        db.commit()


@pytest.mark.parametrize("path", ["/contact", "/support", "/demo", "/affiliate"])
def test_public_forms_save_messages(web, path):
    web.cookies.clear()
    main.login_attempts.clear()
    assert web.post(path, data={"email": "bad", "message": "x"}).status_code == 400
    assert web.post(path, data={"email": "person@leo.test", "name": "P", "message": "A long enough message."}).status_code == 303
    with SessionLocal() as db:
        from app.db import Ticket
        assert db.query(Ticket).filter(Ticket.subject.ilike(path[1:] + "%")).count() >= 1


def test_failed_email_shows_an_error(web, monkeypatch):
    web.cookies.clear()
    main.login_attempts.clear()
    monkeypatch.setattr(main, "send_email", lambda *a, **k: False)
    page = web.post("/login/code", data={"email": "nomail@leo.test"})
    assert page.status_code == 502 and "send your code" in page.text


def test_page_cannot_inject_html(web):
    login(web, "org@leo.test")
    web.post("/org/support", data={"subject": "<script>alert(1)</script>", "message": "x"})
    assert "<script>alert(1)" not in web.get("/org/support").text


def test_scoring_failure_is_reported_not_stuck(web):
    login(web, "org@leo.test")
    item_id, token = invite(web, backend_job(), "fail@leo.test")
    async def broken(item, turns):
        raise RuntimeError("OpenAI returned 500 sk-SECRETKEY123")
    good, iv.score_transcript = iv.score_transcript, broken
    web.post(f"/i/{token}/session", content="v=0", headers={"content-type": "application/sdp"})
    web.post(f"/i/{token}/finish", json={"usage": USAGE, "end_reason": "time_up", "transcript": [{"speaker": "candidate", "text": "hi"}]})
    asyncio.run(main.score_and_save(item_id))
    iv.score_transcript = good
    with SessionLocal() as db:
        item = db.get(Interview, item_id)
        assert item.status == "finished" and "could not be created" in item.report_error and "SECRET" not in item.report_error


def test_password_login_and_new_pages(web):
    assert web.get("/ai-interviewer").status_code == 200
    assert web.get("/cert/nope").status_code == 404
    bad = web.post("/login/password", data={"email": "nobody@leo.test", "password": "wrongwrong"})
    assert bad.status_code == 400


def test_password_flow_cert_links_and_uploads(web):
    login(web, "pw@leo.test", "interview")
    assert web.post("/me/set-password", data={"password": "short", "confirm": "short"}, follow_redirects=False).status_code == 303
    assert web.post("/me/set-password", data={"password": "long enough 1", "confirm": "long enough 1"}, follow_redirects=False).status_code == 303
    assert web.post("/me/photo", content=b"<svg onload=alert(1)>").status_code == 400
    assert web.post("/me/profile", data={"name": "Pw", "linkedin": "javascript:alert(1)", "github": "github.com/pw"}, follow_redirects=False).status_code == 303
    page_text = web.get("/me/profile").text
    assert "javascript:alert" not in page_text and "https://github.com/pw" in page_text
    web.post("/logout")
    assert web.post("/login/password", data={"email": "pw@leo.test", "password": "wrong password"}).status_code == 400
    good = web.post("/login/password", data={"email": "pw@leo.test", "password": "long enough 1"}, follow_redirects=False)
    assert good.status_code == 303 and "leo_session" in good.cookies
    from app.db import Badge, SessionLocal, User
    with SessionLocal() as db:
        person = db.query(User).filter_by(email="pw@leo.test").first()
        db.add(Badge(user_id=person.id, name="Python fundamentals", cert_hash="a" * 32))
        db.commit()
    assert "Python fundamentals" in web.get("/cert/" + "a" * 32).text
    assert "View certificate" in web.get("/me/certs").text
    web.post("/logout")
    login(web, "settings-org@leo.test")
    web.post("/org/new", data={"name": "Settings Org"})
    assert web.get("/org/invitations").status_code == 200
    assert web.get("/org/settings").status_code == 200
    assert web.post("/org/logo", content=b"not an image").status_code == 400
    assert web.post("/org/logo", content=b"\x89PNG\r\n\x1a\n123").status_code == 200
    web.post("/logout")


class FakeVoice:
    def __init__(self):
        self.on_text = None
        self.audio = 0

    async def transcribe(self, on_text):
        self.on_text = on_text
        await asyncio.sleep(3600)

    async def send_audio(self, chunk):
        self.audio += len(chunk)
        if chunk == b"say":
            self.on_text("I use Python daily", True)

    async def stop(self):
        pass

    def generate(self, system, messages, allow_tool):
        assert messages[0]["role"] == "user"
        yield "text", "Tell me about Python. What do you use it for?"
        yield "usage", {"inputTokens": 100, "outputTokens": 20}

    def speak(self, text):
        return b"\x00\x00" * 160


def test_mumbai_voice_drop_and_rejoin(web, monkeypatch):
    import app.main as main
    from app.db import Interview, SessionLocal
    monkeypatch.setenv("VOICE_ROUTE", "mumbai")
    monkeypatch.setattr(main, "make_voice_services", lambda language: FakeVoice())
    monkeypatch.setattr("app.voice_mumbai.TURN_SILENCE_SECONDS", 0.01)
    login(web, "mumbai@leo.test", "interview")
    web.post("/me/practice", data={"title": "Python dev", "skills": "Python", "description": "Python work", "minutes": "5"}, follow_redirects=False)
    with SessionLocal() as db:
        item = db.query(Interview).filter_by(candidate_email="mumbai@leo.test").one()
        item_id = item.id
        token = main.token_for(item)
    assert web.get(f"/i/{token}/config").json()["voice_route"] == "mumbai"
    lobby = web.get(f"/i/{token}/check")
    assert "AWS services in Mumbai" in lobby.text
    assert "go to OpenAI, outside India" not in lobby.text
    with web.websocket_connect(f"/i/{token}/voice") as socket:
        ready = socket.receive_json()
        assert ready["type"] == "leo.ready" and ready["seconds"] == 300
        socket.send_text(json.dumps({"type": "response.create"}))
        seen = []
        while "response.done" not in seen:
            message = socket.receive()
            if message.get("text"):
                seen.append(json.loads(message["text"])["type"])
        socket.send_bytes(b"say")
        seen = []
        while "conversation.item.input_audio_transcription.completed" not in seen:
            seen.append(socket.receive_json()["type"])
        done = web.post(f"/i/{token}/finish", json={"end_reason": "page_closed", "proctoring": [{"type": "tab_switch"}], "transcript": [{"speaker": "candidate", "text": "forged"}]})
        assert done.json()["rejoin"] is True
    config = web.get(f"/i/{token}/config").json()
    assert config["rejoin"] and config["proctoring"] == [{"type": "tab_switch"}]
    assert "I use Python daily" in str(config["transcript"]) and "forged" not in str(config["transcript"])
    with web.websocket_connect(f"/i/{token}/voice") as socket:
        assert socket.receive_json()["seconds"] <= 300
        web.post(f"/i/{token}/finish", json={"end_reason": "connection_lost"})
    with SessionLocal() as db:
        found = db.get(Interview, item_id)
        found.disconnected_at = main.now() - main.timedelta(seconds=301)
        db.commit()
    assert web.get(f"/i/{token}/config").json()["rejoin"] is False
    assert main.settle_dropped_calls() == [item_id]
    with SessionLocal() as db:
        found = db.get(Interview, item_id)
        found.status = "finished"
        db.commit()
    web.cookies.clear()


def test_bad_reports_are_rejected_and_never_crash_the_page():
    with pytest.raises(ValueError):
        iv.checked_report({"summary": "No scores here"})
    good = iv.checked_report({"summary": "Fine", "overallScore": "40", "technicalScore": 30, "communicationScore": 500, "qnaEvaluations": [{"question": "Q"}]})
    assert good["overallScore"] == 40 and good["communicationScore"] == 100 and good["strengths"] == []
    assert good["qnaEvaluations"][0]["candidateAnswer"] == "No answer" and good["conduct"] == "none"
    from app.db import Interview
    assert Interview(report_json='{"summary": "No scores"}').report is None


def test_logged_in_people_do_not_see_log_in_on_public_pages(web):
    web.cookies.clear()
    assert 'href="/login">Log in' in web.get("/jobs").text
    login(web, "header@leo.test", "interview")
    page_text = web.get("/jobs").text
    assert 'href="/login">Log in' not in page_text and "My account" in page_text
    web.cookies.clear()


def test_old_credit_and_certification_urls_redirect(web):
    for old, new in {"/org/credits": "/org/billing", "/me/credits": "/me/wallet", "/me/certifications": "/me/certs"}.items():
        reply = web.get(old, follow_redirects=False)
        assert reply.status_code == 301 and reply.headers["location"] == new


def test_report_rows_open_the_report(web):
    login(web, "org@leo.test")
    page_text = web.get("/org/reports").text
    title = page_text.split("<title>")[1].split("</title>")[0]
    assert "<script" not in title
    assert 'class="row-link"' in page_text or "Reports appear here" in page_text
    web.cookies.clear()


def test_audit_fixes(web, monkeypatch):
    web.cookies.clear()
    assert "Practis" not in web.get("/").text and "practis" not in web.get("/candidates").text
    assert "use test data only" in web.get("/about").text
    monkeypatch.setenv("VOICE_ROUTE", "mumbai")
    about = web.get("/about").text
    assert "AWS Mumbai" in about and "OpenAI" not in about
    monkeypatch.setenv("VOICE_ROUTE", "openai")
    login(web, "org@leo.test")
    assert "Viewers can only read" in web.get("/org/team").text
    everyone = web.get("/org/candidates/export").text
    nobody = web.get("/org/candidates/export?q=zzz-no-such-person").text
    assert len(everyone.splitlines()) > 1 and len(nobody.splitlines()) == 1
    web.cookies.clear()
    login(web, "audit-new@leo.test", "interview")
    home = web.get("/me").text
    assert "Still to add" in home and "resume" in home and "Start practicing" in home
    web.cookies.clear()
