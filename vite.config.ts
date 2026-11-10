import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const proxy={'/api':{target:'http://127.0.0.1:4310',ws:true}};
export default defineConfig({ plugins: [react()],server:{proxy},preview:{proxy} });
