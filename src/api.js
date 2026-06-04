import fs from 'node:fs';
import path from 'node:path';
import ky, { isHTTPError } from 'ky';

function apiClient() {
    const api = ky.create({
        baseUrl: 'https://misskey.id/api/',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            'Authorization': `Bearer ${process.env.MISSKEY_ACCESS_TOKEN}`,
        },
    });

    return api;
}

async function getUploadFolder() {
    const statePath = path.resolve(process.cwd(), 'state.json');
    let state = {};

    // get upload folder
    try {
        if (fs.existsSync(statePath)) {
            state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (state.kursFolderId) {
                return state.kursFolderId;
            }
        }
    } catch (err) {
        console.error('Gagal membaca state.json:', err);
    }

    // create upload folder if not found
    try {
        console.log('  -> Membuat folder upload baru...');
        const api = apiClient().extend({
            headers: {
                'Content-Type': 'multipart/form-data',
            }
        });
        const folderName = `USD to IDR Uploads`;

        const folder = await api.post('drive/folders/create', { json: { name: folderName } }).json();
        if (!folder?.id) {
            throw new Error('Gagal membuat folder upload');
        }

        state.kursFolderId = folder.id;
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

        return folder.id;
    } catch (error) {
        console.error('Gagal mengambil folder upload:', error);
        return null;
    }
}

async function uploadMedia(buffer, name, comment = null) {
    try {
        // get folder upload
        const folderId = await getUploadFolder();
        if (!folderId) {
            throw new Error('Folder tidak ditemukan');
        }

        const api = apiClient().extend({
            headers: {
                'Content-Type': undefined,
            }
        });

        // `multipart/form-data`
        const formData = new FormData();
        formData.append('folderId', folderId);
        formData.append('file', new Blob([buffer], { type: 'image/png' }), name);
        formData.append('isSensitive', false);
        formData.append('force', false);
        formData.append('name', name);
        formData.append('comment', comment);

        const response = await api.post('drive/files/create', {
            body: formData
        });
        return response;
    } catch (error) {
        if (isHTTPError(error)) {
            console.log('Gagal mengupload file:', error);
        }
        return null;
    }
}

async function postNoteWithMedia(text, mediaId, visibility = 'public') {
    try {
        const api = apiClient();
        const response = await api.post('notes/create', { json: { text, mediaIds: [mediaId], visibility } }).json();
        return response;
    } catch (error) {
        console.error('Gagal memposting note:', error);
        return null;
    }
}


export { apiClient, getUploadFolder, uploadMedia, postNoteWithMedia };