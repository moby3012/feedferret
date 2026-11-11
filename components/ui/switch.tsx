'use client'

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '@/lib/utils'

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer relative data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80 inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent transition-all disabled:cursor-not-allowed disabled:opacity-50 focus-ring',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={
          'bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none absolute left-0.5 top-1/2 block size-5 -translate-y-1/2 rounded-full ring-0 transition-all data-[state=checked]:left-[calc(100%-1.375rem)] data-[state=unchecked]:left-0.5'
        }
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
