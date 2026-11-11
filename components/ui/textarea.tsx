import * as React from 'react'

import { cn } from '@/lib/utils'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'ui-control-surface placeholder:text-muted-foreground aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full rounded-panel border px-3 py-2 text-body transition-[color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50 md:text-body-sm focus-ring',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
