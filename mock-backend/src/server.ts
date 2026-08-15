import express, { type Request, type Response } from 'express';

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use((req: Request, res: Response) => {
  res.json({
    message: 'Hello from backend',
    path: req.path,
    receivedAt: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`[mock-backend] listening on port ${PORT}`);
});
