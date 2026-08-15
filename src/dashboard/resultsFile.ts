import fs from 'fs';
import path from 'path';

export function projectRootFrom(dirname: string): string {
  return path.join(dirname, '..');
}

export function resultsFilePath(root: string): string {
  return path.join(root, 'load-test-results.json');
}

function isRunSummary(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.total === 'number' && rec.latency != null;
}

export function readHistory(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { runs?: unknown }).runs)) {
      return ((parsed as { runs: unknown[] }).runs).filter(isRunSummary);
    }
    if (isRunSummary(parsed)) return [parsed];
    return [];
  } catch {
    return [];
  }
}
