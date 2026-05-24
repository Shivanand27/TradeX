"""
One-time script to create the admin user in Supabase.
Run from the backend directory: python scripts/create_admin.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from supabase import create_client
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

ADMIN_EMAIL = "admin@tradex.com"
ADMIN_PASSWORD = "TradeX@2026"
ADMIN_NAME = "TradeX Admin"

db = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# Create auth user
print(f"Creating auth user: {ADMIN_EMAIL}")
try:
    auth_resp = db.auth.admin.create_user({
        "email": ADMIN_EMAIL,
        "password": ADMIN_PASSWORD,
        "email_confirm": True,
    })
    uid = auth_resp.user.id
    print(f"Auth user created: {uid}")
except Exception as e:
    print(f"Auth user creation failed: {e}")
    sys.exit(1)

# Insert into users table with is_admin=True
try:
    db.table("users").insert({
        "id": uid,
        "email": ADMIN_EMAIL,
        "full_name": ADMIN_NAME,
        "plan": "admin",
        "status": "active",
        "is_admin": True,
        "payment_ref": "",
        "amount_paid": 0,
    }).execute()
    print(f"Admin user record inserted successfully.")
except Exception as e:
    print(f"users table insert failed: {e}")
    try:
        db.auth.admin.delete_user(uid)
        print("Rolled back auth user.")
    except Exception:
        pass
    sys.exit(1)

print(f"\nAdmin user created successfully!")
print(f"  Email   : {ADMIN_EMAIL}")
print(f"  User ID : {uid}")
print(f"  is_admin: True")
