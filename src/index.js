import { createApp } from './app.js';
import { startScheduler } from './slots.js';
import { startKeepAlive } from './keepalive.js';
import { ensureSeed } from './seed.js';
import { cloudEnabled } from './storage.js';
import { captchaEnabled } from './security.js';

await ensureSeed();
const app = createApp();
startScheduler();
startKeepAlive();

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`IntelSquad API running on http://localhost:${PORT}`);
  console.log(`  uploads: ${cloudEnabled ? 'Cloudinary' : 'local disk'} | captcha: ${captchaEnabled ? 'Turnstile' : 'off'}`);
});
