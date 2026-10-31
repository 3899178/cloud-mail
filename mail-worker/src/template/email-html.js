import { parseHTML } from 'linkedom';
import domainUtils from '../utils/domain-uitls';

const escapeAttribute = value => value.replace(/[&<>"']/g, char => ({
 '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

export default function emailHtmlTemplate(html, domain) {
 const { document } = parseHTML(html.replace(/{{domain}}/g, domainUtils.toOssDomain(domain) + '/'));
 // Defense in depth. The opaque, script-disabled iframe below is the
 // execution boundary; parsed HTML alone is not a sanitizer or a sandbox.
 document.querySelectorAll('script,iframe,frame,frameset,object,embed,applet,form,input,button,textarea,select,base,meta,link,svg,math').forEach(node => node.remove());
 for (const node of document.querySelectorAll('*')) {
  for (const attribute of [...node.attributes]) {
   if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
  }
 }
 for (const anchor of document.querySelectorAll('a')) {
  try {
   const url = new URL(anchor.getAttribute('href'));
   if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error();
   anchor.setAttribute('href', url.href);
   anchor.setAttribute('target', '_blank');
   anchor.setAttribute('rel', 'noopener noreferrer');
  } catch {
   anchor.removeAttribute('href');
   anchor.removeAttribute('target');
  }
 }
 const inner = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{background:#fff}body{margin:0;padding:15px;box-sizing:border-box;overflow-wrap:anywhere;font-family:system-ui,sans-serif;line-height:1.5}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${document.toString()}</body></html>`;
 return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mail</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100vh}</style></head><body><iframe title="Mail content" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(inner)}"></iframe></body></html>`;
}
