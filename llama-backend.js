// llama-backend.js — llama.cpp HTTP API client for ismini standalone mode

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const __dirname = new URL('.', import.meta.url).pathname;

export class LlamaBackend {
  constructor(config) {
    this.config = config;
    this.port = config.llamaCpp?.port || 8080;
    this.serverProcess = null;
    this.isReady = false;
  }

  // Start llama.cpp server
  async start() {
    const binPath = join(__dirname, 'llama-cpp', 'llama-server');
    
    if (!existsSync(binPath)) {
      throw new Error('llama-server binary not found at ' + binPath);
    }

    return new Promise((resolve, reject) => {
      console.log(`[llama] Starting server on port ${this.port}...`);
      
      // Start with GPU layers auto
      const args = [
        '--port', String(this.port),
        '--cont-batching',
        '--metrics'
      ];

      this.serverProcess = spawn(binPath, args);

      let startupOutput = '';
      this.serverProcess.stdout.on('data', (data) => {
        const output = data.toString();
        startupOutput += output;
        console.log(`[llama] ${output.trim()}`);
        
        if (output.includes('HTTP server listening')) {
          console.log('[llama] Server ready!');
          this.isReady = true;
          resolve(true);
        }
      });

      this.serverProcess.stderr.on('data', (data) => {
        const output = data.toString();
        startupOutput += output;
        console.error(`[llama stderr] ${output.trim()}`);
      });

      this.serverProcess.on('error', (err) => {
        reject(new Error(`Failed to start llama-server: ${err.message}`));
      });

      // Timeout after 30 seconds
      const timeout = setTimeout(() => {
        if (!this.isReady && !reject.called) {
          reject(new Error('llama-server startup timeout'));
        }
      }, 30000);
      
      this.serverProcess.on('exit', (code, signal) => {
        clearTimeout(timeout);
        this.isReady = false;
        console.log(`[llama] Server exited with code ${code}, signal ${signal}`);
      });
    });
  }

  // Stop llama.cpp server
  async stop() {
    if (this.serverProcess && !this.serverProcess.killed) {
      console.log('[llama] Stopping server...');
      this.serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      
      if (!this.serverProcess.killed) {
        this.serverProcess.kill('SIGKILL');
      }
      
      this.isReady = false;
    }
  }

  // Check if server is running
  async checkServer() {
    try {
      const resp = await fetch(`http://localhost:${this.port}/health`, { 
        timeout: 5000,
        signal: AbortSignal.timeout(5000)
      });
      return true;
    } catch {
      return false;
    }
  }

  // Generate text with llama.cpp
  async generate(text, messages, modelId) {
    if (!this.isReady && !(await this.checkServer())) {
      await this.start();
    }

    const messagesForApi = this._formatMessages(messages);
    
    const payload = {
      prompt: text,
      messages: messagesForApi,
      stream: true,
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 2048
    };

    try {
      const resp = await fetch(`http://localhost:${this.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300000) // 5 min timeout
      });

      if (!resp.ok) {
        throw new Error(`llama.cpp API error: ${resp.status} ${resp.statusText}`);
      }

      return await resp.text();

    } catch (err) {
      console.error('[llama] Generation failed:', err.message);
      this.isReady = false;
      throw err;
    }
  }

  // Format messages for llama.cpp chat completions API
  _formatMessages(messages) {
    return messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }));
  }

  // List available models (for future model manager integration)
  async listModels() {
    try {
      const resp = await fetch(`http://localhost:${this.port}/models`);
      if (resp.ok) {
        return await resp.json();
      }
    } catch {}
    return [];
  }
}