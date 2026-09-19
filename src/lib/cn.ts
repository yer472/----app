/** 拼接 className，自动忽略 false / null / undefined */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}
