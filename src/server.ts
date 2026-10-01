import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { createApp } from './app.js';

const app = createApp();

app.listen(env.PORT, env.HOST, () => {
  logger.info(`API berjalan di http://${env.HOST}:${env.PORT}`);
});
