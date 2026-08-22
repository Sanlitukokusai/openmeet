import type { Config } from 'tailwindcss'
import { heroui } from '@heroui/theme'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
    './node_modules/@heroui/theme/dist/**/*.{js,mjs,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // 系统字体栈：禁止 next/font/google / 任何远程字体（规格书 §8.1）
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'PingFang SC',
          'Hiragino Kaku Gothic ProN',
          'Hiragino Sans',
          'Noto Sans JP',
          'Microsoft YaHei',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [heroui()],
}

export default config
