import ky, { isHTTPError } from "ky";
import { loadState, saveState } from "./state.js";

function apiClient() {
	const baseUrl = process.env.MISSKEY_API_BASE_URL;
	const accessToken = process.env.MISSKEY_ACCESS_TOKEN;
	const userAgent = process.env.USER_AGENT;

	if (!baseUrl) {
		throw new Error("MISSKEY_API_BASE_URL is not defined");
	}

	if (!accessToken) {
		throw new Error("MISSKEY_ACCESS_TOKEN is not defined");
	}

	const api = ky.create({
		prefix: baseUrl,
		headers: {
			"Content-Type": "application/json",
			"User-Agent": userAgent || "USDtoIDR-Bot",
			Authorization: `Bearer ${accessToken}`,
		},
	});

	return api;
}

async function getUploadFolder() {
	if (process.env.MISSKEY_FOLDER_ID) {
		return process.env.MISSKEY_FOLDER_ID;
	}

	const state = loadState();

	if (state.kursFolderId) {
		return state.kursFolderId;
	}

	// create upload folder if not found
	try {
		console.log("  -> Membuat folder upload baru...");
		const api = apiClient().extend({
			headers: {
				"Content-Type": "multipart/form-data",
			},
		});
		const folderName = `USD to IDR Uploads`;

		const folder = await api
			.post("drive/folders/create", { json: { name: folderName } })
			.json();
		if (!folder?.id) {
			throw new Error("Gagal membuat folder upload");
		}

		state.kursFolderId = folder.id;
		saveState(state);

		return folder.id;
	} catch (error) {
		console.error("Gagal mengambil folder upload:", error);
		return null;
	}
}

async function uploadMedia(buffer, name, comment = null) {
	try {
		// get folder upload
		const folderId = await getUploadFolder();
		if (!folderId) {
			throw new Error("Folder tidak ditemukan");
		}

		const api = apiClient().extend({
			headers: {
				"Content-Type": undefined,
			},
		});

		// `multipart/form-data`
		const formData = new FormData();
		formData.append("folderId", folderId);
		formData.append(
			"file",
			new Blob([buffer], { type: "image/png" }),
			name || "image.png",
		);

		// Jangan tambahkan value jika null/undefined, karena di FormData akan berubah jadi string "undefined"
		if (name) formData.append("name", name);
		if (comment) formData.append("comment", comment);

		const response = await api
			.post("drive/files/create", {
				body: formData,
			})
			.json();

		return response;
	} catch (error) {
		if (isHTTPError(error)) {
			console.log(
				`Gagal mengupload file: ${error.response.status} ${error.response.statusText}`,
			);
		}
		return null;
	}
}

async function postNoteWithMedia(text, mediaId, visibility = "public") {
	try {
		const api = apiClient();
		const response = await api
			.post("notes/create", { json: { text, mediaIds: [mediaId], visibility } })
			.json();
		return response;
	} catch (error) {
		console.error("Gagal memposting note:", error);
		return null;
	}
}

export { apiClient, getUploadFolder, postNoteWithMedia, uploadMedia };
