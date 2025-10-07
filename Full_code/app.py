# app.py
import os
import uuid
from flask import Flask, render_template, request, redirect, url_for, flash, session, jsonify
from werkzeug.utils import secure_filename
from pypdf import PdfReader
import docx
import shutil
import stat
import logging

# LangChain / OpenAI
from langchain_chroma import Chroma
from langchain_openai import OpenAIEmbeddings
from langchain_text_splitters import CharacterTextSplitter
from openai import OpenAI
from dotenv import load_dotenv
import os, os.path

# load environment variables from .env for the OpenAI code
#load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

# ---------- Flask setup ----------
BASEDIR = os.path.dirname(__file__)
load_dotenv(os.path.join(BASEDIR, ".env"))  # load .env before creating the app

app = Flask(__name__)

# ✅ REQUIRED for sessions/flash — try FLASK_SECRET_KEY, then SECRET_KEY, then a dev fallback
app.config["SECRET_KEY"] = (
    os.getenv("FLASK_SECRET_KEY")
    or os.getenv("SECRET_KEY")
    or "dev-change-me-please"  # replace in production
)

app.config["UPLOAD_FOLDER"] = os.path.join(BASEDIR, "uploads")
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

# Allowed extensions (unchanged)
ALLOWED_EXTENSIONS = {"pdf", "docx", "txt"}

# ---------- Helpers ----------
def allowed_file(filename: str) -> bool:
    """Check extension against the allowed set."""
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS

def extract_text_from_pdf(file_path: str) -> str:
    """Extract text from PDF pages (no OCR)."""
    try:
        with open(file_path, "rb") as f:
            reader = PdfReader(f)
            return "".join([(page.extract_text() or "") for page in reader.pages])
    except Exception as e:
        return f"Error extracting text from PDF: {e}"

def extract_text_from_docx(file_path: str) -> str:
    """Extract text from DOCX paragraphs."""
    try:
        d = docx.Document(file_path)
        return "\n".join([p.text for p in d.paragraphs if p.text.strip()])
    except Exception as e:
        return f"Error extracting text from DOCX: {e}"

def process_uploaded_file(file_storage):
    """
    Save the uploaded file securely and extract its text content.
    Returns (text, base_name_without_ext, sanitized_filename).
    """
    filename = secure_filename(file_storage.filename)
    save_path = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    file_storage.save(save_path)

    lower = filename.lower()
    if lower.endswith(".pdf"):
        text = extract_text_from_pdf(save_path)
    elif lower.endswith(".docx"):
        text = extract_text_from_docx(save_path)
    elif lower.endswith(".txt"):
        with open(save_path, "r", encoding="utf-8", errors="ignore") as f:
            text = f.read()
    else:
        text = "Unsupported file type."

    base_name_without_ext = os.path.splitext(filename)[0]
    return text, base_name_without_ext, filename


def get_openai_client():
    """Create an OpenAI client using the API key in the environment."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set in environment.")
    return OpenAI(api_key=api_key)


def get_document_prompt(docs):
    """Format a list of strings or LangChain Documents into a numbered prompt block."""
    out = []
    for i, d in enumerate(docs, 1):
        text = d if isinstance(d, str) else getattr(d, "page_content", "")
        out.append(f"\nContent {i}:\n{text}\n")
    return "\n".join(out)

def _on_rm_error(func, path, exc_info):
    """Windows-safe remover: make file writable then retry."""
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except Exception:
        logging.warning("Could not remove: %s", path)


# ---------- Routes ----------
@app.post("/home")
def home():
    """Clear session + remove the last Chroma DB dir, then go 'home'."""
    # grab the dir BEFORE clearing session
    persist_dir = session.get("persist_directory")

    # try to remove the vector DB folder (optional but recommended)
    if persist_dir and os.path.isdir(persist_dir):
        try:
            shutil.rmtree(persist_dir, onerror=_on_rm_error)
        except Exception as e:
            app.logger.warning("Failed to remove persist dir %s: %s", persist_dir, e)

    # clear ALL session keys
    session.clear()
    flash("Start by uploading a new file.", "success")
    return redirect(url_for("index"))


@app.route("/", methods=["GET", "POST"])
def index():
    #GET: render page using any cached summary in session
    #POST: save file, build index, generate summary once, cache it, then redirect (PRG)
    if request.method == "POST":
        if "file" not in request.files:
            flash("No file part in request.", "error"); 
            return redirect(request.url)

        f = request.files["file"]
        if f.filename == "":
            flash("No file selected.", "error"); 
            return redirect(request.url)

        if not allowed_file(f.filename):
            flash("Unsupported file type. Please upload PDF, DOCX, or TXT.", "error")
            return redirect(request.url)

        # Save + extract the new upload
        text, base, filename = process_uploaded_file(f)

        # Reset/initialize session state for this new upload
        persist_dir = os.path.abspath(f"./chroma_db_{base}_{uuid.uuid4().hex[:8]}")
        session["persist_directory"] = persist_dir
        session["uploaded_filename"] = filename
        session["summary_text"] = None
        session["summary_generated"] = False

        flash("✅ Notebook uploaded successfully", "success")

        # --- Build index + generate summary ONCE for this upload ---
        try:
            os.makedirs(persist_dir, exist_ok=True)

            #slip text into chunks
            text_splitter = CharacterTextSplitter(separator=" ", chunk_size=5000, chunk_overlap=100)
            docs = text_splitter.split_text(text) if text else []

            #create embeddings + chroma
            client = get_openai_client()
            embeddings = OpenAIEmbeddings(model="text-embedding-3-large", openai_api_key=client.api_key)
            vectordb = Chroma(embedding_function=embeddings, persist_directory=persist_dir)

            #add docs in batches
            batch = 50
            for i in range(0, len(docs), batch):
                vectordb.add_texts(docs[i:i + batch])
            #vectordb.persist()

            #pulls some docs and create a prompt
            raw = vectordb.get(include=["documents"])
            all_docs = raw.get("documents", [])
            sample = all_docs[:15] if all_docs else []
            prompt = get_document_prompt(sample) if sample else "No content available."

            system_message = (
                f"Generate a summary of the following notebook content: "
                f"\n\n###\n{prompt}\n###\n\n"
                "The summary should contain the title of the book and a short sentence about the notebook"
                "The summary should never be move that 8 sentences"
                "Be precise, avoid opinions, and summarize the main points in a clear and structured way. "
                "If the document has multiple sections, break it into meaningful segments."
            )

            #call openAI for the summary
            resp = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "system", "content": system_message}],
                temperature=0.2,
            )
            session["summary_text"] = resp.choices[0].message.content
            session["summary_generated"] = True

        except Exception as e:
            flash(f"⚠️ Could not build index or generate summary: {e}", "error")

        # PRG: avoid re-POST on refresh, and avoid double generation
        return redirect(url_for("index"))

    # GET: render whatever we have in session (summary shown if present)
    return render_template(
        "index.html",
        filename=session.get("uploaded_filename"),
        summary=session.get("summary_text")
    )


@app.route("/ask", methods=["POST"])
def ask():
    data = request.get_json(silent=True) or {}
    question = data.get("question", "").strip()
    if not question:
        return jsonify({"ok": False, "error": "Question is required."}), 400

    persist_dir = session.get("persist_directory", "")
    if not persist_dir or not os.path.isdir(persist_dir):
        return jsonify({"ok": False, "error": "Please upload a Notebook before asking a Question."}), 400

    client = get_openai_client()
    embeddings = OpenAIEmbeddings(model="text-embedding-3-large", openai_api_key=client.api_key)
    vectordb = Chroma(embedding_function=embeddings, persist_directory=persist_dir)

    # Retrieve relevant docs
    retrieved = vectordb.similarity_search(question, k=10)
    context = get_document_prompt(retrieved)

    system_message = (
        f"You are a professor teaching a course. Use the following notebook content "
        f"to answer student questions accurately and concisely:\n\n{context}\n\n"
        "Be precise and avoid opinions."
        "Only state what is in the notebook content"
        "Do not state what is not in the given notebook and be very precise and straight forward "
    )

    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_message},
            {"role": "user", "content": question},
        ],
        temperature=0.1,
    )
    answer = resp.choices[0].message.content
    return jsonify({"ok": True, "answer": answer})
    

@app.route("/generate_quiz", methods=["POST"])
def generate_quiz():
    """
    Generate multiple-choice questions from the vector DB.
    Expects: JSON { "num_questions": 5 }
    """
    num = int((request.get_json(silent=True) or {}).get("num_questions", 5))

    persist_dir = session.get("persist_directory", "")
    if not persist_dir or not os.path.isdir(persist_dir):
        return jsonify({"ok": False, "error": "Please upload a Notebook before generating Quiz."}), 400

    client = get_openai_client()
    embeddings = OpenAIEmbeddings(model="text-embedding-3-large", openai_api_key=client.api_key)
    vectordb = Chroma(embedding_function=embeddings, persist_directory=persist_dir)

    raw = vectordb.get(include=["documents"])
    all_docs = raw.get("documents", [])
    sample = all_docs[:20] if all_docs else []
    context = get_document_prompt(sample) if sample else "No content available."

    system_message = (
        f"Generate {num} multiple-choice quiz questions from the following notebook content: "
        f"\n\n###\n{context}\n###\n\n"
        f"Each question should have 4 answer choices (A,B,C,D) and indicate the correct answer at the end:"
        f"""the format of the reply should be
        Question 1: <question>
        A)  <answer choice A>
        B)  <answer choice B>
        C)  <answer choice C>
        D)  <answer choice D>
        Correct Answer: C

        Question 2: <question>
         ..."""
         )
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "system", "content": system_message}],
        temperature=0.2,
    )
    text = resp.choices[0].message.content.strip()

    # Parse very simply
    blocks = [b for b in text.split("\n\n") if b.strip()]
    quiz = []
    for b in blocks:
        lines = b.splitlines()
        if len(lines) >= 6 and lines[0].lower().startswith("question"):
            q = lines[0].strip()
            choices = lines[1:5]
            correct = lines[5].split(":")[-1].strip()
            quiz.append({"question": q, "choices": choices, "correct": correct})

    return jsonify({"ok": True, "quiz": quiz})

if __name__ == "__main__":
    app.run(debug=True)
