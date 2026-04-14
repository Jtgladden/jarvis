from dotenv import load_dotenv
import os

load_dotenv()

GMAIL_TOKEN_FILE = os.getenv("GMAIL_TOKEN_FILE", "token.json")
GMAIL_CREDENTIALS_FILE = os.getenv("GMAIL_CREDENTIALS_FILE", "credentials.json")
GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]