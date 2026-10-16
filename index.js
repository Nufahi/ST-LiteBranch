import { initialize } from './ui.js';

jQuery(() => initialize().catch(error => console.error('[LiteBranch] initialization failed', error)));
