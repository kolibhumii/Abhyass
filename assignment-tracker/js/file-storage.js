import { storage } from "./firebase.js";
import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytesResumable,
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-storage.js";

export const PDF_UPLOAD_RULES = Object.freeze({
  allowedExtensions: [".pdf"],
  allowedContentTypes: ["application/pdf"],
  maxSizeBytes: 10 * 1024 * 1024,
});

function cleanSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "") || "file";
}

function formatFileSize(size) {
  const bytes = Number(size || 0);
  if (!bytes) return "0 KB";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.max(bytes / 1024, 0.1).toFixed(1)} KB`;
}

export function describePdfUploadRules() {
  return `Only PDF files are allowed. Maximum ${formatFileSize(
    PDF_UPLOAD_RULES.maxSizeBytes
  )}.`;
}

export function validatePdfFile(file) {
  if (!file) {
    return "Please choose a PDF file.";
  }

  const name = String(file.name || "").toLowerCase();
  const type = String(file.type || "").toLowerCase();
  const isPdf =
    PDF_UPLOAD_RULES.allowedExtensions.some((extension) =>
      name.endsWith(extension)
    ) || PDF_UPLOAD_RULES.allowedContentTypes.includes(type);

  if (!isPdf) {
    return "Only PDF files are allowed.";
  }

  if (Number(file.size || 0) > PDF_UPLOAD_RULES.maxSizeBytes) {
    return `PDF files must be ${formatFileSize(
      PDF_UPLOAD_RULES.maxSizeBytes
    )} or smaller.`;
  }

  return "";
}

export async function uploadPdfFile(pathSegments, file, { onProgress } = {}) {
  const fileName = cleanSegment(file.name || "document.pdf");
  const storagePath = [...pathSegments.map(cleanSegment), fileName].join("/");
  const storageRef = ref(storage, storagePath);

  const uploadTask = uploadBytesResumable(storageRef, file, {
    contentType: "application/pdf",
  });

  const snapshot = await new Promise((resolve, reject) => {
    uploadTask.on(
      "state_changed",
      (nextSnapshot) => {
        if (!nextSnapshot.totalBytes) return;
        onProgress?.(
          Math.max(
            1,
            Math.min(
              100,
              Math.round(
                (nextSnapshot.bytesTransferred / nextSnapshot.totalBytes) * 100
              )
            )
          )
        );
      },
      reject,
      () => resolve(uploadTask.snapshot)
    );
  });

  const downloadURL = await getDownloadURL(snapshot.ref);

  return {
    downloadURL,
    storagePath,
    fileName: file.name || fileName,
    size: Number(file.size || 0),
    contentType: "application/pdf",
  };
}

export function buildStoredPdfRecord(upload, uploadedAt = Date.now()) {
  if (!upload) return null;

  return {
    url: upload.downloadURL || "",
    name: upload.fileName || "",
    size: Number(upload.size || 0),
    type: upload.contentType || "application/pdf",
    storagePath: upload.storagePath || "",
    uploadedAt,
  };
}

export function formatFirebaseUploadError(error, action = "complete the upload") {
  const code = String(error?.code || "").toLowerCase();

  if (code === "storage/unauthenticated") {
    return "Your session expired before the file could upload. Please sign in again and retry.";
  }

  if (code === "storage/unauthorized") {
    return `Firebase Storage rules blocked this request while trying to ${action}. If the project is still using test mode, those rules may have expired.`;
  }

  if (code === "storage/quota-exceeded") {
    return "Firebase Storage quota has been exceeded, so new files cannot be uploaded right now.";
  }

  if (code === "permission-denied" || code === "firestore/permission-denied") {
    return `Firebase Firestore rules blocked this request while trying to ${action}. Please verify the database rules for the signed-in user.`;
  }

  return error?.message || `Unable to ${action}.`;
}

export async function deleteStoredFile(storagePath) {
  if (!storagePath) return;
  await deleteObject(ref(storage, storagePath));
}
