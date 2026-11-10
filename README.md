# Leo

Leo is an AI voice interview platform. A candidate joins a live voice interview with an AI interviewer named Maya, whose questions come from the job description. Afterwards an AI scores the transcript and writes a report for the hiring team.

The goal is a 30-minute interview for under $1 in AI costs, with candidate data kept in India (AWS Mumbai).

## Features

**For hiring teams**
- Create jobs, with an AI-drafted description
- Invite candidates by email or CSV
- Proctored voice interviews with recordings
- Scored reports with answer-by-answer feedback
- Shortlist or reject candidates
- Team roles, company logo and CSV export

**For candidates**
- Practice interviews for any role
- Skill certifications with public certificate links
- Profile with photo, links and resume autofill
- Rejoin within 5 minutes if a call drops

## How the voice works

The production route is a speech-to-text, language model, text-to-speech pipeline, all in AWS Mumbai:

```
Candidate's microphone
  -> Amazon Transcribe (speech to text)
  -> Amazon Bedrock, Mistral Ministral 3 8B (Maya's replies)
  -> Amazon Polly, voice Kajal (text to speech)
  -> Candidate's speakers
```

Grading uses DeepSeek V3.2 on Bedrock, also in Mumbai.

An older route using OpenAI Realtime, which handles speech directly, is still available by setting `VOICE_ROUTE=openai`. It doesn't keep data in India.

## Cost

Measured on one real 5-minute interview: $0.141 including grading. This is Leo's own estimate from fixed prices, not an AWS bill.

Estimated for a 30-minute interview:

| Part | Cost |
|---|---|
| Speech to text (Transcribe) | about $0.72 |
| Maya's voice (Polly) | about $0.08 |
| Maya's replies and grading (Bedrock) | about $0.02 |
| **Total** | **about $0.82** |

For comparison, OpenAI Realtime cost $2 or more. Sending audio only while the candidate speaks, which is not built yet, would bring this to about $0.50.

The server adds about $14-15 a month while running and about $6 while stopped. No GPU is used.

## Tech stack

Python, FastAPI, Jinja2, SQLAlchemy and plain JavaScript. SQLite locally and PostgreSQL in production. Deployed on AWS with CloudFormation, Caddy and Amazon SES.

## Run locally

Requires Python 3.9 or later.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
./run.sh
```

Then open http://127.0.0.1:8010. Without email set up, login codes are shown on screen and sample data is created.

Run the tests:

```bash
.venv/bin/python -m pytest tests -q
```

## Deploy

Upload `app`, `deploy` and `requirements.txt` to AWS CloudShell in the Mumbai region and run `deploy/aws-deploy.sh` with a verified Amazon SES email address.

## Project status

Working: accounts and login, organizations, jobs, invitations, the interview call, proctoring, scoring, reports, credits, certifications and deployment.

Not finished yet:
- Real lip sync for Maya's video
- Lower-cost audio streaming
- Own domain and email delivery outside the SES sandbox
- Payments, which were left out by design

## Never commit

`.env`, `data/` or any keys. They are already listed in `.gitignore`.
