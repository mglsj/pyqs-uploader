import base64
import os
import jwt
import time
import requests
from flask import Flask, request, render_template

if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv(override=True)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY")

# GitHub App Config
APP_ID = os.getenv("APP_ID")
PRIVATE_KEY = os.getenv("PRIVATE_KEY") or ""
REPO_OWNER = os.getenv("REPO_OWNER")
REPO_NAME = os.getenv("REPO_NAME")
BASE_BRANCH = os.getenv("BASE_BRANCH")


def generate_jwt():
    """Generate a JSON Web Token (JWT) for GitHub App authentication."""
    payload = {
        "iat": int(time.time()),
        "exp": int(time.time()) + (10 * 60),  # 10 minutes expiration
        "iss": APP_ID,
    }
    return jwt.encode(payload, PRIVATE_KEY, algorithm="RS256")


def get_installation_access_token():
    """Exchange JWT for Installation Access Token."""
    jwt_token = generate_jwt()
    url = f"https://api.github.com/app/installations"
    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "Accept": "application/vnd.github+json",
    }
    response = requests.get(url, headers=headers)
    installation_id = response.json()[0]["id"]

    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    response = requests.post(url, headers=headers)
    return response.json()["token"]


@app.route("/", methods=["GET", "POST"])
def upload_file():
    if request.method == "POST":
        # Get the uploaded file
        uploaded_file = request.files["file"]
        if not uploaded_file or not uploaded_file.filename.endswith(".pdf"):
            return "Please upload a valid PDF file."

        # Read and encode the file
        file_content = uploaded_file.read()
        encoded_content = base64.b64encode(file_content).decode("utf-8")
        file_name = request.form["filename"]

        path = request.form["path"]
        file_path = ""

        if path:
            path = path.strip("/").replace("pyqs/", "")
            file_path = f"{path}/{file_name}"

        else:
            return "Please provide a valid path."

        # GitHub actions
        try:
            access_token = get_installation_access_token()

            # print("Getting the latest commit SHA")
            # Step 1: Get the latest commit SHA
            ref_url = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/git/refs/heads/{BASE_BRANCH}"
            headers = {"Authorization": f"token {access_token}"}
            ref_response = requests.get(ref_url, headers=headers)
            base_commit_sha = ref_response.json()["object"]["sha"]

            # print("Creating a new branch")
            # Step 2: Create a new branch
            new_branch = f"upload-{int(time.time())}"
            create_branch_url = (
                f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/git/refs"
            )
            branch_response = requests.post(
                create_branch_url,
                headers=headers,
                json={"ref": f"refs/heads/{new_branch}", "sha": base_commit_sha},
            )

            # print("Uploading the file")
            # Step 3: Upload the file
            # file_path = f"uploads/{file_name}"
            upload_url = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/contents/{requests.utils.quote(file_path)}"
            upload_response = requests.put(
                upload_url,
                headers=headers,
                json={
                    "message": f"Add {file_name}",
                    "content": encoded_content,
                    "branch": new_branch,
                },
            )

            # print("Creating a pull request")
            # Step 4: Create a pull request
            pr_url = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/pulls"
            pr_body = f"""
This is an autogenrated PR to add a new file to the repository.

- File: `{file_name}`
- Path: `{file_path}`

>[!NOTE]
>This PR is created by a bot.

### Details

- exam_subject_code: `{request.form["exam_subject_code"]}`
- exam_specialization_code: `{request.form["exam_specialization_code"]}`
- exam_type: `{request.form["exam_type"]}`
- back: `{True if "back" in request.form else False}`
- exam_year: `{request.form["exam_year"]}`
- exam_month: `{request.form["exam_month"]}`
- exam_date: `{request.form["exam_date"]}`
- exam_set: `{request.form["exam_set"]}`

### Contributor

- Name: `{request.form["contributor_name"]}`
- Course: `{request.form["contributor_course"]}`
- Batch: `{request.form["contributor_batch"]}`
"""
            # print("body", pr_body)
            pr_response = requests.post(
                pr_url,
                headers=headers,
                json={
                    "title": f"[PYQS UPLOADER] {file_name}",
                    "body": pr_body,
                    "head": new_branch,
                    "base": BASE_BRANCH,
                },
            )
            pr_data = pr_response.json()
            return render_template("success.html", pull_request_url=pr_data["html_url"])
        except Exception as e:
            # raise e
            # print(e)
            return f"Error: {str(e)}"

    return render_template("index.html")


if __name__ == "__main__":
    app.run(debug=True)
