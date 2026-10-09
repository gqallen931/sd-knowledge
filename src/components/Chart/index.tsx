import { useRef, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption, ECharts } from 'echarts'

interface ChartProps {
  option: EChartsOption
  height?: string
  className?: string
  onChartReady?: (chart: ECharts) => void
}

export default function Chart({ option, height = '200px', className = '', onChartReady }: ChartProps) {
  const chartRef = useRef<any>(null)

  useEffect(() => {
    if (chartRef.current && onChartReady) {
      const instance = chartRef.current.getEchartsInstance()
      onChartReady(instance)
    }
  }, [onChartReady])

  return (
    <div className={className} style={{ width: '100%', height }}>
      <ReactECharts
        ref={chartRef}
        option={option}
        style={{ height: '100%', width: '100%' }}
        notMerge={true}
        lazyUpdate={true}
        opts={{ renderer: 'canvas' }}
      />
    </div>
  )
}
