import type { Express, Request, Response } from 'express';
import express from 'express';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { projectRootFrom, resultsFilePath, readHistory } from './resultsFile';

const MAX_TOTAL = 10_000_000;
const ALLOWED_PATHS = new Set(['mixed', '/api/search', '/api/ping', '/api/orders']);

let runningChild: ChildProcess | null = null;

export function registerDashboard(app: Express, dirname: string): void {
  const root = projectRootFrom(dirname);
  const dashboardDir = path.join(root, 'dashboard');
  const scriptPath = path.join(root, 'scripts', 'load-test.mjs');
  const resultsPath = resultsFilePath(root);

  app.get('/dashboard/results', (_req: Request, res: Response) => {
    res.json({ runs: readHistory(resultsPath) });
  });

  app.get('/dashboard/status', (_req: Request, res: Response) => {
    res.json({ running: runningChild != null });
  });

  app.post('/dashboard/run', express.json({ limit: '16kb' }), (req: Request, res: Response) => {
    if (runningChild) {
      res.status(409).json({ error: 'A load test is already running' });
      return;
    }

    const total = Number(req.body?.total);
    if (!Number.isInteger(total) || total < 1 || total > MAX_TOTAL) {
      res.status(400).json({ error: `total must be an integer from 1 to ${MAX_TOTAL}` });
      return;
    }

    const pathOpt = typeof req.body?.path === 'string' ? req.body.path : 'mixed';
    if (!ALLOWED_PATHS.has(pathOpt)) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }

    const args = [scriptPath, String(total), '--path', pathOpt];
    const clients = req.body?.clients;
    if (clients != null && clients !== '') {
      const n = Number(clients);
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        res.status(400).json({ error: 'clients must be an integer from 1 to 1000' });
        return;
      }
      args.push('--clients', String(n));
    }

    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningChild = child;
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('error', (err: Error) => {
      console.error('[dashboard] failed to spawn load test:', err.message);
      if (runningChild === child) runningChild = null;
    });
    child.on('close', (code) => {
      if (runningChild === child) runningChild = null;
      if (code !== 0) {
        console.error('[dashboard] load test exited with code', code);
      }
    });

    res.status(202).json({ running: true, total, path: pathOpt });
  });

  app.get('/dashboard', (_req: Request, res: Response) => {
    res.sendFile(path.join(dashboardDir, 'index.html'));
  });
  app.use('/dashboard', express.static(dashboardDir, { index: 'index.html' }));
}
