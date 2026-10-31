// C-ONE UI specification v1.1: shared by Tailwind and dashboard charts.
export const colors = {
  primary: '#0070F2', primaryDark: '#0057B8', navy: '#0A285F',
  text: '#172B4D', secondary: '#526581', muted: '#8696A9', disabled: '#AAB5C2',
  canvas: '#F3F6FA', content: '#F7F9FC', surface: '#FFFFFF', sidebar: '#F8FAFC',
  header: '#EDF3F8', border: '#DCE4ED', divider: '#E9EEF4', input: '#B8C7D8',
  tableDivider: '#E8EDF3', hover: '#F0F6FC',
};
export const brand = {
  50: '#F0F6FC', 100: '#E5F0FA', 200: '#DCEEFF', 300: '#A6D2FF',
  400: '#66ADFF', 500: '#1688ED', 600: colors.primary, 700: colors.primaryDark,
  800: '#00418A', 900: colors.navy, 950: '#061B40',
};
// Darker label variants keep small status text above 4.5:1 contrast.
export const statusColors = {
  success: { background: '#E5F5EB', text: '#107E3E' },
  pending: { background: '#FFF3DF', text: '#C77700', label: '#8A5200' },
  warning: { background: '#FFF0DB', text: '#E9730C', label: '#9E4A00' },
  error: { background: '#FCE8E8', text: '#BB0000' },
  info: { background: '#E5F1FC', text: '#0064D9' },
  neutral: { background: '#EDF1F5', text: '#526581' },
  progress: { background: '#DCEEFF', text: '#0070F2', label: colors.primaryDark },
};
export const chartColors = {
  cutting: '#1688ED', sewing: '#20B978', finishing: '#FF9B32', packing: '#8054E9',
  dispatch: '#EC638C', inventory: '#20B5B5', purchase: '#E5B83D', delayed: '#E84C4C', other: '#8293A8',
};
// Inter ships with the app (SIL OFL) so every PC renders the same face; 72 / Segoe UI only if it fails to load.
export const fontFamily = ['"Inter Variable"', '"72"', '"Segoe UI"', 'Arial', 'sans-serif'];
// Type scale (spec §10) in rem so the A− / A / A+ text-size control scales every screen alike.
export const fontSize = {
  micro: '0.625rem', caption: '0.6875rem', small: '0.75rem', body: '0.8125rem',
  'body-lg': '0.875rem', title: '0.9375rem', 'title-lg': '1rem', page: '1.5rem',
};
