/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        sd: {
          primary: '#3b82f6',
          dark: '#1e40af',
          light: '#dbeafe',
          accent: '#8b5cf6',
        }
      }
    },
  },
  plugins: [],
}
