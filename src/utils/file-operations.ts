import { promises as fs } from "fs";
import { join, dirname } from "path";

/**
 * Modern async file operations to replace synchronous file operations
 */

/**
 * Read a file asynchronously
 */
export async function readFile(path: string, encoding: BufferEncoding = "utf8"): Promise<string> {
  return fs.readFile(path, encoding);
}

/**
 * Write a file asynchronously, creating directories if needed
 */
export async function writeFile(path: string, data: string | Buffer): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, data);
}

/**
 * Read a JSON file and parse it
 */
export async function readJSON<T = unknown>(path: string): Promise<T> {
  const content = await readFile(path);
  return JSON.parse(content) as T;
}

/**
 * Write a JSON file with pretty formatting
 */
export async function writeJSON(path: string, data: unknown, spaces = 2): Promise<void> {
  const content = JSON.stringify(data, null, spaces);
  await writeFile(path, content);
}

/**
 * Check if a file exists
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * List files in a directory
 */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(dir, entry.name));
}

/**
 * List directories in a directory
 */
export async function listDirectories(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name));
}

/**
 * Remove a file if it exists
 */
export async function removeFile(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Copy a file
 */
export async function copyFile(source: string, destination: string): Promise<void> {
  const dir = dirname(destination);
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(source, destination);
}

/**
 * Get file stats
 */
export async function getFileStats(path: string): Promise<fs.Stats> {
  return fs.stat(path);
}