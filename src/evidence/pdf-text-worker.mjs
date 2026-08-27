import { parentPort, workerData } from "node:worker_threads";
import { PDFParse } from "pdf-parse";

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function parse() {
  const parser = new PDFParse({
    data: workerData.bytes,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    isEvalSupported: false,
    stopAtErrors: true,
    maxImageSize: 1_000_000,
  });
  try {
    const info = await parser.getInfo();
    const total = Number(info?.total);
    if (!Number.isSafeInteger(total) || total < 1) throw failure("pdf_parse_failed", "PDF page count is invalid");
    if (workerData.requestedPage !== undefined && workerData.requestedPage > total) {
      throw failure("page_out_of_range", `Requested page ${workerData.requestedPage} exceeds the PDF's ${total} pages`);
    }
    if (workerData.requestedPage === undefined && total > workerData.maxPdfPagesWithoutSelection) {
      throw failure("page_required", `PDF has ${total} pages; a page is required above the ${workerData.maxPdfPagesWithoutSelection}-page extraction limit`);
    }
    const result = await parser.getText({
      ...(workerData.requestedPage === undefined ? { first: total } : { partial: [workerData.requestedPage] }),
      pageJoiner: "",
    });
    const pages = (result?.pages ?? []).map((entry) => ({ num: Number(entry.num), text: String(entry.text ?? "") }));
    if (!pages.length || pages.some((entry) => !Number.isSafeInteger(entry.num) || entry.num < 1)) {
      throw failure("pdf_parse_failed", "PDF text extraction returned invalid page data");
    }
    const extractedBytes = pages.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
    if (extractedBytes > workerData.maxExtractedTextBytes) {
      throw failure("text_too_large", `Extracted PDF text exceeds the ${workerData.maxExtractedTextBytes}-byte processing limit`);
    }
    if (!pages.some((entry) => /[\p{L}\p{N}]/u.test(entry.text))) {
      throw failure("text_unavailable", "Archived PDF has no extractable text layer");
    }
    return { ok: true, total, pages };
  } finally {
    await parser.destroy();
  }
}

if (!parentPort) throw new Error("PDF text worker requires a parent port");

let message;
try {
  message = await parse();
} catch (error) {
  message = {
    ok: false,
    error: {
      code: typeof error?.code === "string" ? error.code : "pdf_parse_failed",
      message: String(error?.message ?? error).slice(0, 240),
    },
  };
}
parentPort.postMessage(message);
