import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['node_modules/**', '.next/**', 'out/**', 'build/**', 'next-env.d.ts'],
  },
  // ============================================================
  // MediaProvider 抽象层强制执行（docs/DESIGN-v2.md §3.1 / §11 WP-3 验收项）
  // 规则：livekit-client 只允许在 lib/media/providers/livekit/ 目录下 import，
  // 其余所有代码（页面/组件/hooks/store）只能依赖 lib/media/types.ts 的接口。
  // 用 flat config 的分组 files 覆盖实现：先全局禁，再在 providers/livekit
  // 目录下解禁（数组靠后的配置对同一文件优先生效）。
  // ============================================================
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'livekit-client',
              message:
                '禁止在此处直接 import livekit-client：只允许出现在 lib/media/providers/livekit/ 目录下' +
                '（规格书 §3.1）。请改为依赖 lib/media/types.ts 中的 MediaProvider 接口，' +
                '通过 lib/media/index.ts 的 createMediaProvider() 获取实例。',
            },
            {
              // 2026-08-13 FR-7：背景ぼかし / バーチャル背景。
              // 同属媒体实现细节，与 livekit-client 一视同仁；另外它连带
              // @mediapipe/tasks-vision（几百 KB + wasm），在别处 import 还会
              // 破坏 §8.2 的「不进首屏 bundle」——provider 内部只以 dynamic import 加载。
              name: '@livekit/track-processors',
              message:
                '禁止在此处直接 import @livekit/track-processors：只允许出现在 ' +
                'lib/media/providers/livekit/ 目录下（规格书 §3.1）。背景效果请通过 ' +
                'lib/media/types.ts 的 MediaProvider.setBackgroundEffect() / ' +
                'isBackgroundEffectSupported() 使用。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['lib/media/providers/livekit/**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      // 注：WP-0 阶段这里还额外关过 @typescript-eslint/no-unused-vars（占位桩的
      // 未使用参数需要豁免）。WP-3 实装完成后占位桩已不存在，豁免随之移除。
    },
  },
]

export default eslintConfig
