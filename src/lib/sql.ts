/** Tiny positional-parameter builder: b.p(value) → "$n". Keeps dynamic filters injection-safe. */
export class SqlBuilder {
  params: unknown[] = [];
  where: string[] = [];
  p(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  and(cond: string) {
    this.where.push(cond);
    return this;
  }
  whereSql(): string {
    return this.where.length ? 'WHERE ' + this.where.join(' AND ') : '';
  }
}

export function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}
