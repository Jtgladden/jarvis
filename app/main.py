from fastapi import FastAPI, Query
from app.gmail_client import get_recent_inbox_emails
from app.schemas import EmailSummary

app = FastAPI(title="Mail AI", version="0.1.0")


@app.get("/")
def root():
    return {"message": "Mail AI backend is running"}


@app.get("/emails", response_model=list[EmailSummary])
def list_emails(max_results: int = Query(default=10, ge=1, le=50)):
    return get_recent_inbox_emails(max_results=max_results)