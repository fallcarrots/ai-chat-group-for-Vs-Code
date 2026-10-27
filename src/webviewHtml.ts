/**
 * 通用 Webview HTML 装载器。
 * 负责读取 media/ 下的模板，并替换 CSP / nonce / 资源 URI 占位符。
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

export interface WebviewHtmlOptions {
  context: vscode.ExtensionContext;
  webview: vscode.Webview;
  /** media/ 下的 HTML 文件名，如 chat.html */
  htmlFile: string;
  /** media/ 下的脚本文件名，如 main.js */
  scriptFile: string;
  /** media/ 下的样式文件名，如 style.css */
  styleFile: string;
}

export function renderWebviewHtml(options: WebviewHtmlOptions): string {
  const { context, webview, htmlFile, scriptFile, styleFile } = options;
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  const htmlPath = vscode.Uri.joinPath(mediaRoot, htmlFile).fsPath;

  let html: string;
  try {
    html = fs.readFileSync(htmlPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<!DOCTYPE html><html lang="zh-CN"><body><h2>无法加载界面</h2><pre>${escapeHtml(
      message,
    )}</pre></body></html>`;
  }

  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, scriptFile)).toString();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, styleFile)).toString();
  const nonce = randomBytes(16).toString('base64');

  return html
    .split('{{cspSource}}')
    .join(webview.cspSource)
    .split('{{nonce}}')
    .join(nonce)
    .split('{{scriptUri}}')
    .join(scriptUri)
    .split('{{styleUri}}')
    .join(styleUri);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
