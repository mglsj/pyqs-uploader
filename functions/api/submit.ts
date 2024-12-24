/**
 * POST /api/submit
 */
import jwt from "@tsndr/cloudflare-worker-jwt";

interface Env {
	APP_ID: string;
	PRIVATE_KEY: string;
	REPO_OWNER: string;
	REPO_NAME: string;
	BASE_BRANCH: string;
	BASE_URL: string;
}

async function generateJWT(iss: string, pk: string): Promise<string> {
	const payload = {
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000 + 10 * 60), // 10 minutes expiration
		iss: iss,
	};
	return await jwt.sign(payload, pk, {
		algorithm: "RS256",
	});
}

async function getInstallationId(
	headers: HeadersInit,
	env: Env,
): Promise<string | undefined> {
	// fecth installations
	const installations: { id: string; account: { login: string } }[] =
		await fetch("https://api.github.com/app/installations", {
			method: "GET",
			headers: headers,
		}).then((response) => {
			if (!response.ok) {
				// console.log(response);
				throw new Error(`HTTP error! status: ${response.status}`);
			}
			return response.json();
		});

	// find the installation ID for the repo owner
	return installations.find((inst) => inst.account.login === env.REPO_OWNER)
		?.id;
}

async function getInstallationAccessToken(env: Env): Promise<string> {
	const headers = {
		Authorization: `Bearer ${await generateJWT(env.APP_ID, env.PRIVATE_KEY)}`,
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "GitHub API Client for Cloudflare Workers",
	};

	const installationID = await getInstallationId(headers, env);

	// get the access token for the installation
	const accessTokenResponse: { token: string } = await fetch(
		`https://api.github.com/app/installations/${installationID}/access_tokens`,
		{
			method: "POST",
			headers: headers,
		},
	).then((response) => {
		if (!response.ok) {
			// console.log(response);
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		return response.json();
	});

	return accessTokenResponse.token;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
	const formData = await context.request.formData();

	const uploaded_file = formData.get("file") as File;

	if (!uploaded_file.name.endsWith(".pdf")) {
		return new Response("Please upload a PDF file", {
			status: 400,
			headers: {
				"Content-Type": "text/plain",
			},
		});
	}

	// load uploaded file as Buffer<ArrayBuffer>
	const fileContent = await uploaded_file.arrayBuffer();
	const encodedContent = Buffer.from(fileContent).toString("base64");

	const path: string = formData.get("path") as string;

	if (!path.startsWith("pyqs/")) {
		return new Response("Invalid path", {
			status: 400,
			headers: {
				"Content-Type": "text/plain",
			},
		});
	}

	const file_path = `${path.replace(/^\/|\/$/g, "").replace("pyqs/", "")}/${formData.get("filename") as string}`;

	try {
		const accessToken = await getInstallationAccessToken(context.env);

		// Step 1: Get the latest commit SHA
		const refResponse: { object: { sha: string } } = await fetch(
			`https://api.github.com/repos/${context.env.REPO_OWNER}/${context.env.REPO_NAME}/git/ref/heads/${context.env.BASE_BRANCH}`,
			{
				method: "GET",
				headers: {
					Authorization: `token ${accessToken}`,
					"User-Agent": "GitHub API Client for Cloudflare Workers",
				},
			},
		).then((response) => {
			if (!response.ok) {
				// console.log(response);
				throw new Error(`HTTP error! status: ${response.status}`);
			}
			return response.json();
		});

		const baseCommitSha = refResponse.object.sha;

		// Step 2: Create a new branch
		const newBranchName = `upload-${Date.now()}`;
		await fetch(
			`https://api.github.com/repos/${context.env.REPO_OWNER}/${context.env.REPO_NAME}/git/refs`,
			{
				method: "POST",
				headers: {
					Authorization: `token ${accessToken}`,
					"Content-Type": "application/json",
					"User-Agent": "GitHub API Client for Cloudflare Workers",
				},
				body: JSON.stringify({
					ref: `refs/heads/${newBranchName}`,
					sha: baseCommitSha,
				}),
			},
		);

		// Step 3: Upload the file
		await fetch(
			`https://api.github.com/repos/${context.env.REPO_OWNER}/${context.env.REPO_NAME}/contents/${encodeURIComponent(file_path)}`,
			{
				method: "PUT",
				headers: {
					Authorization: `token ${accessToken}`,
					"Content-Type": "application/json",
					"User-Agent": "GitHub API Client for Cloudflare Workers",
				},
				body: JSON.stringify({
					message: `[PYQ Uploader] ${formData.get("filename")}`,
					content: encodedContent,
					branch: newBranchName,
				}),
			},
		);

		// Step 4: Create a PR
		const prBody = `
This is an autogenrated PR to add a new file to the repository.

- Original: \`${uploaded_file.name}\`
- File: \`${formData.get("filename") as string}\`
- Path: \`${file_path}\`

>[!NOTE]
>This PR is created by a bot.

### Details

- exam_subject_code: \`${formData.get("exam_subject_code")}\`
- exam_specialization_code: \`${formData.get("exam_specialization_code")}\`
- exam_type: \`${formData.get("exam_type")}\`
- back: \`${formData.get("back") !== null}\`
- exam_year: \`${formData.get("exam_year")}\`
- exam_month: \`${formData.get("exam_month")}\`
- exam_date: \`${formData.get("exam_date")}\`
- exam_set: \`${formData.get("exam_set")}\`

### Contributor

- Name: \`${formData.get("contributor_name")}\`
- Course: \`${formData.get("contributor_course")}\`
- Batch: \`${formData.get("contributor_batch")}\`
`;

		const prResponse: { html_url: string } = await fetch(
			`https://api.github.com/repos/${context.env.REPO_OWNER}/${context.env.REPO_NAME}/pulls`,
			{
				method: "POST",
				headers: {
					Authorization: `token ${accessToken}`,
					"Content-Type": "application/json",
					"User-Agent": "GitHub API Client for Cloudflare Workers",
				},
				body: JSON.stringify({
					title: `[PYQ Uploader] ${formData.get("filename")}`,
					head: newBranchName,
					body: prBody,
					base: context.env.BASE_BRANCH,
				}),
			},
		).then((response) => {
			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}
			return response.json();
		});

		const prUrl = prResponse.html_url || "";

		return Response.redirect(
			`${context.env.BASE_URL}/success/?pr_url=${encodeURIComponent(prUrl)}`,
			303,
		);
	} catch (e) {
		console.error(e);
		return new Response(`Internal Server Error ${e}`, {
			status: 500,
			headers: {
				"Content-Type": "text/plain",
			},
		});
	}
};
