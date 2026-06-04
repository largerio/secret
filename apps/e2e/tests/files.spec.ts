import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createNote, revealNote } from "./helpers";

let fixtureDir: string;

test.beforeAll(() => {
	fixtureDir = mkdtempSync(path.join(tmpdir(), "secret-e2e-files-"));
});

test.afterAll(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

/** Writes a fixture file with known bytes and returns its absolute path. */
function writeFixture(name: string, contents: string): string {
	const filePath = path.join(fixtureDir, name);
	writeFileSync(filePath, contents);
	return filePath;
}

test("a file round-trips: attached on create, downloaded intact on read", async ({
	page,
	context,
}) => {
	const contents = `attachment payload ${Date.now()}\nline two — zero knowledge`;
	const filePath = writeFixture("secret.txt", contents);

	const shareUrl = await createNote(page, {
		text: "see attachment",
		files: [filePath],
		maxReads: 3,
	});

	const reader = await context.newPage();
	await revealNote(reader, shareUrl);

	// The attachments section appears with the original file name.
	await expect(reader.getByText(/Attachments/i)).toBeVisible({ timeout: 15_000 });
	await expect(reader.getByText("secret.txt")).toBeVisible();

	// Downloading must yield the exact original bytes (proves the encrypted round-trip).
	const downloadPromise = reader.waitForEvent("download");
	await reader.getByRole("button", { name: /Download/i }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe("secret.txt");

	const downloadedPath = await download.path();
	expect(readFileSync(downloadedPath, "utf8")).toBe(contents);
});

test("multiple files are all listed and downloadable", async ({ page, context }) => {
	const a = writeFixture("alpha.txt", `alpha ${Date.now()}`);
	const b = writeFixture("beta.txt", `beta ${Date.now()}`);

	const shareUrl = await createNote(page, {
		text: "two attachments",
		files: [a, b],
		maxReads: 3,
	});

	const reader = await context.newPage();
	await revealNote(reader, shareUrl);

	await expect(reader.getByText("alpha.txt")).toBeVisible({ timeout: 15_000 });
	await expect(reader.getByText("beta.txt")).toBeVisible();
	// One Download button per attachment.
	await expect(reader.getByRole("button", { name: /Download/i })).toHaveCount(2);
});
