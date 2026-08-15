import express, { type Request, type Response } from 'express';

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const INSTANCE_ID = process.env.INSTANCE_ID || `backend-${PORT}`;

app.use((req: Request, res: Response) => {
  res.json({
    message: 'Hello from backend',
    instance: INSTANCE_ID,
    path: req.path,
    receivedAt: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`[mock-backend] ${INSTANCE_ID} listening on port ${PORT}`);
});
