'use client';
/**
 * Multi-series line chart where clicking a point opens /inbox for that bucket + series
 * (charts.Lines has no drill-down). Same visual rules: one y-axis, thin lines, legend + table toggle via ChartCard.
 */
import { useRouter } from 'next/navigation';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { EmptyChart, fillTemplate, type SeriesDef } from '@/components/charts';

const GRID = '#efe9dd';
const AXIS = { fontSize: 11, fill: '#6b6258' };

export function DrillLines({ data, xKey, series, hrefTemplate, height = 250 }: {
  data: Record<string, any>[]; xKey: string; series: SeriesDef[]; hrefTemplate: string; height?: number;
}) {
  const router = useRouter();
  if (!data.length) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={12} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e8e2d6' }} cursor={{ stroke: '#d6cdbd' }} />
        <Legend iconType="plainline" iconSize={12} wrapperStyle={{ fontSize: 11, paddingTop: 6 }} />
        {series.map((s) => (
          <Line key={s.key} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} type="monotone" connectNulls
            dot={{ r: 2, strokeWidth: 0, fill: s.color }}
            activeDot={{
              r: 5, stroke: '#fff', strokeWidth: 2, cursor: 'pointer',
              onClick: (_: any, e: any) => { const row = e?.payload ?? {}; router.push(fillTemplate(hrefTemplate, { ...row, series: s.key })); },
            } as any} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
