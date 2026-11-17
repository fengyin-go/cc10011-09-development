/**
 * 测试用 ESM loader：把 "@/..." 别名映射到编译输出目录，并为无扩展名相对导入补 .js。
 * 仅服务于 scripts 下的 node 逻辑测试，vite 构建不受影响。
 */
import { pathToFileURL } from 'node:url'

const outRoot = new URL('../.test-build/src/', import.meta.url)

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = new URL(specifier.slice(2), outRoot)
    return nextResolve(ensureJs(target.href), context)
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?js$/.test(specifier)) {
    const parentUrl = context.parentURL
    const target = new URL(specifier, parentUrl)
    try {
      return await nextResolve(target.href, context)
    } catch {
      return nextResolve(ensureJs(target.href), context)
    }
  }
  return nextResolve(specifier, context)
}

function ensureJs(href) {
  if (/\.[cm]?js$/.test(href)) {
    return href
  }
  const url = new URL(href)
  url.pathname = `${url.pathname}.js`
  return url.href
}

export const pathRoot = pathToFileURL(outRoot.pathname)
