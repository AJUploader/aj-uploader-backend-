import asyncio
import os
import uuid
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
)

# --------------------------------------------------
# إعدادات التوكن
# --------------------------------------------------
BOT_TOKEN = os.getenv("BOT_TOKEN", "8992720397:AAH49aajO_CVjg7HOC8P-srncwEZod7ff8k")

app = FastAPI()

# السماح للإضافة بالاتصال بالخادم بدون قيود CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# تخزين الجلسات والاتصالات الحية
active_connections: dict[str, WebSocket] = {}

# --------------------------------------------------
# 1. نقاط مسارات الـ API والـ WebSocket (للإضافة)
# --------------------------------------------------


@app.post("/api/request-login")
async def request_login():
    session_id = str(uuid.uuid4())
    # رابط يفتح البوت مباشرة مع معرف الجلسة
    telegram_link = f"https://t.me/AJUploader_Bot?start={session_id}"
    return {"session_id": session_id, "telegram_link": telegram_link}


@app.websocket("/ws/login/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await websocket.accept()
    active_connections[session_id] = websocket
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if session_id in active_connections:
            del active_connections[session_id]


# --------------------------------------------------
# 2. معالجة أوامر وأزرار بوت التليجرام
# --------------------------------------------------


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    args = context.args
    session_id = args[0] if args else None

    if session_id:
        text = (
            "🔒 *Sign-in request*\n\n"
            "A browser just asked to connect to your *AJ Uploader* account.\n\n"
            "©️ If you just opened the extension, tap *Confirm sign-in*.\n"
            "🛑 If this wasn't you, tap *Not me* — never confirm a code someone sends you."
        )
        keyboard = [
            [
                InlineKeyboardButton(
                    "✅ Confirm sign-in",
                    callback_data=f"confirm_{session_id}",
                )
            ],
            [
                InlineKeyboardButton(
                    "❌ Not me / Cancel", callback_data=f"cancel_{session_id}"
                )
            ],
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        await update.message.reply_text(
            text, reply_markup=reply_markup, parse_mode="Markdown"
        )
    else:
        await update.message.reply_text("أهلاً بك في بوت AJ Uploader!")


async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    data = query.data
    if "_" not in data:
        return

    action, session_id = data.split("_", 1)

    if action == "confirm":
        # إشعار الإضافة فوراً عبر الـ WebSocket
        if session_id in active_connections:
            await active_connections[session_id].send_json(
                {"status": "success", "telegram_id": query.from_user.id}
            )

        new_text = (
            "✅ *Connected!*\n"
            "Go back to the AJ Uploader extension — you're signed in. 🥳"
        )
        new_keyboard = [
            [
                InlineKeyboardButton(
                    "📊 Open Dashboard",
                    web_app={"url": "https://your-domain.com/dashboard"},
                )
            ],
            [
                InlineKeyboardButton(
                    "🔍 Check a Video", callback_data="check_video_prompt"
                )
            ],
        ]
        await query.edit_message_text(
            new_text,
            reply_markup=InlineKeyboardMarkup(new_keyboard),
            parse_mode="Markdown",
        )

    elif action == "cancel":
        await query.edit_message_text("❌ *Cancelled.* Login request denied.")


# --------------------------------------------------
# 3. تشغيل البوت عند بدء تشغيل الخادم
# --------------------------------------------------
telegram_app = Application.builder().token(BOT_TOKEN).build()
telegram_app.add_handler(CommandHandler("start", start_command))
telegram_app.add_handler(CallbackQueryHandler(button_handler))


@app.on_event("startup")
async def startup_event():
    await telegram_app.initialize()
    await telegram_app.start()
    await telegram_app.updater.start_polling()


@app.on_event("shutdown")
async def shutdown_event():
    await telegram_app.updater.stop()
    await telegram_app.stop()
    await telegram_app.shutdown()
