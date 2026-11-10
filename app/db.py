"""Database tables and connection.

Uses SQLite on your computer, and PostgreSQL on AWS when DATABASE_URL is set.
"""

import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, create_engine, inspect, text
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from sqlalchemy.pool import StaticPool

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"


def database_url() -> str:
    return os.getenv("DATABASE_URL", f"sqlite:///{DATA_DIR / 'leo.db'}")


def make_engine(url: str):
    if url.startswith("sqlite"):
        if ":memory:" in url:
            return create_engine(url, connect_args={"check_same_thread": False}, poolclass=StaticPool)
        DATA_DIR.mkdir(exist_ok=True)
        return create_engine(url, connect_args={"check_same_thread": False})
    return create_engine(url, pool_pre_ping=True)


engine = make_engine(database_url())
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
Base = declarative_base()


def now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(120), default="")
    phone = Column(String(30), default="")
    role = Column(String(20), default="candidate")  # candidate, org or admin
    target_role = Column(String(120), default="")
    about = Column(Text, default="")
    skills = Column(Text, default="")
    experience = Column(Text, default="")
    education = Column(Text, default="")
    linkedin = Column(String(300), default="")
    github = Column(String(300), default="")
    portfolio = Column(String(300), default="")
    photo_path = Column(String(500), default="")
    password_hash = Column(String(200), default="")
    credits = Column(Integer, default=0)
    current_org_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=now)


class LoginCode(Base):
    __tablename__ = "login_codes"
    id = Column(Integer, primary_key=True)
    email = Column(String(255), index=True, nullable=False)
    code_hash = Column(String(64), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    attempts = Column(Integer, default=0)
    used = Column(Boolean, default=False)
    created_at = Column(DateTime, default=now)


class LoginSession(Base):
    __tablename__ = "login_sessions"
    id = Column(Integer, primary_key=True)
    token_hash = Column(String(64), unique=True, index=True, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    user = relationship("User")


class Org(Base):
    __tablename__ = "orgs"
    id = Column(Integer, primary_key=True)
    name = Column(String(160), nullable=False)
    credits = Column(Integer, default=0)
    plan = Column(String(40), default="None")
    active = Column(Boolean, default=True)
    logo_path = Column(String(500), default="")
    website = Column(String(300), default="")
    description = Column(Text, default="")
    created_at = Column(DateTime, default=now)


class Member(Base):
    __tablename__ = "members"
    id = Column(Integer, primary_key=True)
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=False, index=True)
    email = Column(String(255), nullable=False, index=True)
    role = Column(String(20), default="recruiter")  # owner, admin, recruiter or viewer
    status = Column(String(20), default="invited")  # invited or active
    created_at = Column(DateTime, default=now)
    org = relationship("Org")


class Job(Base):
    __tablename__ = "jobs"
    id = Column(Integer, primary_key=True)
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=False, index=True)
    title = Column(String(160), nullable=False)
    description = Column(Text, nullable=False)
    skills = Column(Text, default="")
    exp_from = Column(Integer, default=0)
    exp_to = Column(Integer, default=2)
    location = Column(String(120), default="")
    work_type = Column(String(20), default="Remote")
    minutes = Column(Integer, default=30)
    difficulty = Column(String(20), default="Intermediate")
    language = Column(String(20), default="English")
    status = Column(String(20), default="draft")  # draft, live or closed
    created_at = Column(DateTime, default=now)
    org = relationship("Org")


class Interview(Base):
    """One interview: a job invitation, a practice or a certification."""

    __tablename__ = "interviews"
    id = Column(Integer, primary_key=True)
    kind = Column(String(20), nullable=False)  # job, practice or certification
    access_hash = Column(String(64), unique=True, index=True, nullable=False)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True, index=True)
    org_id = Column(Integer, ForeignKey("orgs.id"), nullable=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    candidate_email = Column(String(255), default="", index=True)
    candidate_name = Column(String(120), default="")
    title = Column(String(160), nullable=False)
    description = Column(Text, default="")
    skills = Column(Text, default="")
    exp_from = Column(Integer, default=0)
    exp_to = Column(Integer, default=2)
    difficulty = Column(String(20), default="Intermediate")
    language = Column(String(20), default="English")
    minutes = Column(Integer, default=10)
    credits_charged = Column(Integer, default=0)
    # invited, in_progress, processing, finished, expired or cancelled
    status = Column(String(20), default="invited", index=True)
    stage = Column(String(20), default="invited")  # invited, shortlisted or rejected
    expires_at = Column(DateTime, nullable=True)
    call_id = Column(String(120), default="")
    started_at = Column(DateTime, nullable=True)
    disconnected_at = Column(DateTime, nullable=True)
    ended_at = Column(DateTime, nullable=True)
    end_reason = Column(String(30), default="")
    transcript_json = Column(Text, default="[]")
    proctoring_json = Column(Text, default="[]")
    tokens_json = Column(Text, default="{}")
    report_json = Column(Text, default="")
    report_error = Column(Text, default="")
    overall_score = Column(Float, nullable=True)
    cost_usd = Column(Float, default=0.0)
    created_at = Column(DateTime, default=now)
    job = relationship("Job")

    @property
    def transcript(self):
        return json.loads(self.transcript_json or "[]")

    @property
    def proctoring(self):
        return json.loads(self.proctoring_json or "[]")

    @property
    def report(self):
        report = json.loads(self.report_json) if self.report_json else None
        return report if report and isinstance(report.get("overallScore"), (int, float)) else None


class Application(Base):
    __tablename__ = "applications"
    id = Column(Integer, primary_key=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    status = Column(String(20), default="applied")
    created_at = Column(DateTime, default=now)
    job = relationship("Job")
    user = relationship("User")


class Ledger(Base):
    """Every credit change is one row, so balances can always be explained."""

    __tablename__ = "ledger"
    id = Column(Integer, primary_key=True)
    org_id = Column(Integer, nullable=True, index=True)
    user_id = Column(Integer, nullable=True, index=True)
    delta = Column(Integer, nullable=False)
    reason = Column(String(200), nullable=False)
    created_at = Column(DateTime, default=now)


class Invoice(Base):
    __tablename__ = "invoices"
    id = Column(Integer, primary_key=True)
    org_id = Column(Integer, nullable=True, index=True)
    user_id = Column(Integer, nullable=True, index=True)
    description = Column(String(200), nullable=False)
    amount_inr = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=now)


class Badge(Base):
    __tablename__ = "badges"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String(160), nullable=False)
    interview_id = Column(Integer, nullable=True)
    cert_hash = Column(String(32), unique=True, index=True, nullable=True)
    created_at = Column(DateTime, default=now)


class Ticket(Base):
    __tablename__ = "tickets"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, nullable=True, index=True)
    org_id = Column(Integer, nullable=True, index=True)
    email = Column(String(255), default="")
    topic = Column(String(60), default="")
    subject = Column(String(200), nullable=False)
    message = Column(Text, nullable=False)
    reply = Column(Text, default="")
    status = Column(String(20), default="open")
    created_at = Column(DateTime, default=now)


class Outbox(Base):
    """Emails the app would send. A real provider is added at deployment."""

    __tablename__ = "outbox"
    id = Column(Integer, primary_key=True)
    to_email = Column(String(255), nullable=False, index=True)
    subject = Column(String(200), nullable=False)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, default=now)


class Notification(Base):
    __tablename__ = "notifications"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    text = Column(String(300), nullable=False)
    link = Column(String(300), default="")
    read = Column(Boolean, default=False)
    created_at = Column(DateTime, default=now)


class PhoneCode(Base):
    __tablename__ = "phone_codes"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    phone = Column(String(30), nullable=False)
    code_hash = Column(String(64), nullable=False)
    expires_at = Column(DateTime, nullable=False)
    attempts = Column(Integer, default=0)
    used = Column(Boolean, default=False)
    created_at = Column(DateTime, default=now)


class Resume(Base):
    __tablename__ = "resumes"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True, unique=True)
    filename = Column(String(200), nullable=False)
    path = Column(String(500), nullable=False)
    created_at = Column(DateTime, default=now)


class Audit(Base):
    __tablename__ = "audit"
    id = Column(Integer, primary_key=True)
    actor = Column(String(255), nullable=False)
    action = Column(String(200), nullable=False)
    item = Column(String(200), default="")
    created_at = Column(DateTime, default=now)


class Setting(Base):
    __tablename__ = "settings"
    key = Column(String(60), primary_key=True)
    value = Column(String(200), nullable=False)


def add_missing_columns() -> None:
    wanted = {"users": ["linkedin", "github", "portfolio", "photo_path", "password_hash"],
              "orgs": ["logo_path", "website", "description"], "badges": ["cert_hash"], "interviews": ["disconnected_at"]}
    tables = {t.__tablename__: t for t in (User, Org, Badge, Interview)}
    existing = inspect(engine)
    with engine.begin() as conn:
        for table, names in wanted.items():
            have = {c["name"] for c in existing.get_columns(table)}
            for name in names:
                if name not in have:
                    kind = tables[table].__table__.c[name].type.compile(engine.dialect)
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {kind}"))
        for row in conn.execute(text("SELECT id FROM badges WHERE cert_hash IS NULL")).fetchall():
            conn.execute(text("UPDATE badges SET cert_hash = :h WHERE id = :i"), {"h": secrets.token_hex(16), "i": row[0]})


def init_db() -> None:
    Base.metadata.create_all(engine)
    add_missing_columns()
