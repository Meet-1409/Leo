"""Sample data for the demo. Every email ends in .test and no real person is included."""

import json
import os
import secrets
from datetime import timedelta

from .db import Application, Audit, Interview, Job, Ledger, Member, Org, Ticket, User, now

SAMPLE_REPORTS = [
    ("Sample Candidate A", "candidate.a@leo.test", 74, 78, 72, 70, "shortlisted", 0,
     "Clear on concepts, lighter on real examples.",
     ["Explained when to use a queue", "Reasoned through a failure case"],
     ["Unsure how indexes affect writes", "Few examples from real projects", "Short answers on testing"]),
    ("Sample Candidate B", "candidate.b@leo.test", 68, 70, 66, 68, "invited", 1,
     "Solid basics, but needed prompting on system design.",
     ["Good understanding of REST APIs"],
     ["Vague on database transactions", "Did not consider retries", "Little detail on monitoring"]),
    ("Sample Candidate E", "candidate.e@leo.test", 42, 38, 50, 55, "invited", 3,
     "Weak technical depth, with repeated proctoring warnings.",
     [],
     ["Could not explain indexes", "No example of debugging", "Answers stayed very general"]),
]


def sample_report(row) -> dict:
    _name, _email, overall, technical, communication, language, _stage, _flags, summary, strengths, weaknesses = row
    return {
        "candidateLabel": "Candidate", "interviewerLabel": "Interviewer", "overallScore": overall, "communicationScore": communication,
        "technicalScore": technical, "cultureFitScore": None, "languageScore": language, "summary": summary, "strengths": strengths,
        "weaknesses": weaknesses, "recommendations": ["Prepare concrete examples from past projects", "Review how databases handle concurrent writes"],
        "conduct": "none", "conductNotes": "",
        "qnaEvaluations": [
            {"question": "When would you choose a queue over a direct call?", "candidateAnswer": "When the work can finish later, like sending emails, so a slow service does not hold up the request.",
             "idealAnswer": "When work can be asynchronous, spikes need smoothing or a downstream service is unreliable. Mention retries, idempotency and dead letter queues.", "score": min(overall + 8, 100), "feedback": "Correct reasoning, with no mention of failure handling."},
            {"question": "What happens if that email job fails halfway?", "candidateAnswer": "It should retry a few times and then we log it.",
             "idealAnswer": "Retry with backoff, keep the job idempotent so that no email is sent twice, and move repeated failures to a dead letter queue with an alert.", "score": overall, "feedback": "Knows retries, but missed duplicate sends."},
            {"question": "How do indexes affect writes in PostgreSQL?", "candidateAnswer": "I think they make reads faster, but I am not sure about writes.",
             "idealAnswer": "Every index must be updated on write, so more indexes slow inserts and updates and use more storage. Choose them based on real query patterns.", "score": max(overall - 30, 5), "feedback": "Only half answered the question."},
        ],
    }


def seed(db) -> None:
    """Sample data for a developer's computer. Production starts empty."""
    if os.getenv("LEO_ENV", "local") == "production" or db.query(User).first():
        return
    db.add_all([User(email="org@leo.test", name="Sample Recruiter", role="org"),
                User(email="candidate@leo.test", name="Sample Candidate", role="candidate", credits=100, target_role="Backend Engineer",
                     about="Backend developer who enjoys APIs.", skills="Python, PostgreSQL, Docker", experience="2 years at Sample Retail, building order APIs.",
                     education="B.Tech, Computer Engineering")])
    org = Org(name="Sample Company", credits=500, plan="Trial")
    db.add(org)
    db.flush()
    db.add(Member(org_id=org.id, email="org@leo.test", role="owner", status="active"))
    db.add(Ledger(org_id=org.id, delta=500, reason="Sample starting credits"))
    candidate = db.query(User).filter_by(email="candidate@leo.test").one()
    db.add(Ledger(user_id=candidate.id, delta=100, reason="Sample starting credits"))
    backend = Job(org_id=org.id, title="Backend Engineer", status="live", minutes=10, exp_from=2, exp_to=4, location="Ahmedabad", work_type="Hybrid", skills="Python, PostgreSQL, API design",
                  description="Build and run the APIs behind our product, using Python and PostgreSQL. You will design endpoints, write tests, tune queries and take part in on-call.")
    analyst = Job(org_id=org.id, title="Data Analyst", status="live", minutes=5, exp_from=0, exp_to=2, location="Remote", work_type="Remote", skills="SQL, Excel, dashboards",
                  description="Turn sales and support data into clear reports. You will write SQL, build dashboards and explain the results to non-technical teams.")
    designer = Job(org_id=org.id, title="Product Designer", status="draft", minutes=10, exp_from=3, exp_to=6, location="Mumbai", work_type="On-site", skills="Figma, user research",
                   description="Design simple, usable product flows, run user interviews and work closely with engineers.")
    db.add_all([backend, analyst, designer])
    db.flush()
    db.add(Application(job_id=analyst.id, user_id=candidate.id))
    stamp = now()
    for index, row in enumerate(SAMPLE_REPORTS):
        name, email, overall, *_rest = row
        report = sample_report(row)
        lines = []
        for qna in report["qnaEvaluations"]:
            lines += [{"speaker": "interviewer", "text": qna["question"]}, {"speaker": "candidate", "text": qna["candidateAnswer"]}]
        flags = [{"type": "no_face", "at_seconds": 40 + n * 60} for n in range(row[7])]
        ended = stamp - timedelta(days=index + 1)
        db.add(Interview(kind="job", access_hash=secrets.token_urlsafe(18), job_id=backend.id, org_id=org.id, candidate_email=email, candidate_name=name,
                         title=backend.title, description=backend.description, skills=backend.skills, exp_from=2, exp_to=4, minutes=10, status="finished", stage=row[6],
                         started_at=ended - timedelta(minutes=10), ended_at=ended, end_reason="time_up", overall_score=overall, report_json=json.dumps(report),
                         transcript_json=json.dumps(lines), proctoring_json=json.dumps(flags)))
    db.add(Ticket(user_id=candidate.id, email=candidate.email, subject="Can I retake a practice?", message="Do practice attempts use new credits each time?"))
    db.add(Audit(actor="admin@leo.test", action="Loaded sample data"))
    db.commit()
