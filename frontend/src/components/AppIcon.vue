<script setup lang="ts">
defineProps<{
  name:
    | "spark"
    | "compass"
    | "route"
    | "wallet"
    | "clock"
    | "waypoint"
    | "map"
    | "pin"
    | "camera"
    | "briefcase";
}>();
</script>

<template>
  <svg v-if="name === 'spark'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3.5 13.9 8l4.6 1.9-4.6 1.9L12 16.5l-1.9-4.7L5.5 9.9 10.1 8 12 3.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M18.2 15.2 19 17l1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8 1.8-.8.8-1.8Z" fill="currentColor"/>
  </svg>
  <svg v-else-if="name === 'compass'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.25" stroke="currentColor" stroke-width="1.7"/>
    <path d="m14.9 9.1-2.4 6.4-3.4 1 1-3.4 6.4-2.4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
  </svg>
  <svg v-else-if="name === 'route'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="6" cy="7" r="2.25" stroke="currentColor" stroke-width="1.7"/>
    <circle cx="18" cy="17" r="2.25" stroke="currentColor" stroke-width="1.7"/>
    <path d="M8.6 7c4.1 0 1.7 6 6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-dasharray="2.5 2.5"/>
  </svg>
  <svg v-else-if="name === 'wallet'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4.5 8.25A2.25 2.25 0 0 1 6.75 6h9.8a2.25 2.25 0 0 1 1.6.66l1.19 1.19c.42.42.66 1 .66 1.6v7.8a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 17.25v-9Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M15.5 13h4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  </svg>
  <svg v-else-if="name === 'clock'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="8.25" stroke="currentColor" stroke-width="1.7"/>
    <path d="M12 7.8v4.7l3.1 1.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <svg v-else-if="name === 'waypoint'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 20c3.5-4 5.25-7 5.25-9.2A5.25 5.25 0 1 0 6.75 10.8C6.75 13 8.5 16 12 20Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <circle cx="12" cy="10.75" r="1.75" fill="currentColor"/>
  </svg>
  <svg v-else-if="name === 'map'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m4.75 6.25 4-1.5 6.5 2.5 4-1.5v12.5l-4 1.5-6.5-2.5-4 1.5V6.25Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M8.75 4.75v12.5M15.25 7.25v12.5" stroke="currentColor" stroke-width="1.7"/>
  </svg>
  <svg v-else-if="name === 'pin'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 20c3.3-3.7 5-6.4 5-8.6a5 5 0 0 0-10 0C7 13.6 8.7 16.3 12 20Z" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="1.7"/>
    <circle cx="12" cy="11.25" r="1.6" fill="currentColor"/>
  </svg>
  <svg v-else-if="name === 'camera'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5.25 8.25h2.6l1.1-1.75h6.1l1.1 1.75h2.6a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-13.5a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <circle cx="12" cy="13.25" r="3" stroke="currentColor" stroke-width="1.7"/>
  </svg>
  <svg v-else viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5.25 6.25h13.5a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5v-8.5a1.5 1.5 0 0 1 1.5-1.5Z" stroke="currentColor" stroke-width="1.7"/>
    <path d="M7.5 10h9M7.5 13.5h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
  </svg>
</template>
