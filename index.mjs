/* dsh-tavern-image-dock 宿主半边。
 *
 * 只干一件事：把配图插件已经画好的原图（PNG）落成普通文件，方便在资源管理器里看。
 *
 * 为什么在宿主侧做：
 *   · 插件接口 handle 的参数只有 256 KB，一张 1.7 MB 的 PNG 传不过来；
 *   · 配图插件的原图就在它自己的缓存目录里（<作业号>.img，内容是 PNG 原图，没有二次压缩），
 *     宿主直接读字节写盘，不经过任何序列化。
 *
 * 默认输出目录：<DSH_HOME>/dsh-tavern-images（没设 DSH_HOME 时是 ~/.dsh/dsh-tavern-images）。
 * 同名文件已存在就跳过、不覆盖：连点两次“一键生成”不会重复堆文件。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-tavern-image-dock'
export const inject = ['tavern']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

// 配图插件的原图缓存：一个作业一张 <作业号>.img
const SOURCE_DIR = join(DSH_HOME, 'profile-data', 'tavern', 'data', 'plugins', 'dsh-tavern-image', 'cache')

// 默认导出位置
const DEFAULT_DIR = join(DSH_HOME, 'dsh-tavern-images')

function pad(value) {
  return String(value).padStart(2, '0')
}

function stampOf(at) {
  const date = new Date(Number(at) || Date.now())
  if (Number.isNaN(date.getTime())) return 'unknown'
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate())
    + '-' + pad(date.getHours()) + pad(date.getMinutes())
}

/** 按文件头判断真实格式：缓存里的扩展名是 .img，实际是 PNG / WebP / JPEG。 */
function extensionOf(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return 'bin'
}

export function apply(ctx) {
  if (!ctx.tavern || ctx.tavern.apiVersion < 2 || typeof ctx.tavern.handle !== 'function') return

  ctx.tavern.handle('dsh-tavern-image-dock/export', async (args) => {
    const gameId = String(args?.gameId || '')
    if (!gameId) throw new Error('缺少 gameId，没有对应这一局，不能导出')

    const entries = Array.isArray(args?.entries) ? args.entries : []
    if (!entries.length) throw new Error('没有可导出的图')

    const target = String(args?.dir || '').trim() || DEFAULT_DIR
    await mkdir(target, { recursive: true })

    const written = []
    const skipped = []
    const failed = []

    for (const entry of entries.slice(0, 300)) {
      const jobId = String(entry?.jobId || '')
      if (!/^[0-9A-Za-z-]{6,64}$/.test(jobId)) {
        failed.push({ jobId, reason: '作业号不合法' })
        continue
      }

      let bytes = null
      try {
        bytes = await readFile(join(SOURCE_DIR, jobId + '.img'))
      } catch (error) {
        failed.push({
          jobId,
          reason: error?.code === 'ENOENT' ? '配图插件的缓存里已经没有这张了' : String(error?.message || error),
        })
        continue
      }

      const turn = Number(entry?.turn) || 0
      const name = (turn ? '第' + turn + '轮_' : '') + stampOf(entry?.createdAt) + '_' + jobId.slice(0, 8) + '.' + extensionOf(bytes)

      try {
        await writeFile(join(target, name), bytes, { flag: 'wx' })
        written.push(name)
      } catch (error) {
        if (error?.code === 'EEXIST') skipped.push(name)
        else failed.push({ jobId, reason: String(error?.message || error) })
      }
    }

    return {
      ok: true,
      dir: target,
      written: written.length,
      skipped: skipped.length,
      failed: failed.slice(0, 20),
    }
  })
}
