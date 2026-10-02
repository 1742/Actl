<script lang="ts" setup>
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/vue';
import { onClickOutside } from '@vueuse/core';
import { onUnmounted, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end' | 'right-start' | 'right-end'
  closeOnMenuClick?: boolean;
  triggerClass?: string;
  menuClass?: string;
}>(), {
  placement: 'top-start',
  closeOnMenuClick: true,
  triggerClass: '',
  menuClass: '',
});

const open = ref(false);

const emit = defineEmits<{
  'update:open': [open: boolean]
}>();
const triggerRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);

const { floatingStyles, isPositioned } = useFloating(triggerRef, menuRef, {
  placement: props.placement,
  open: open,
  middleware: [offset(8), flip(), shift()],
  whileElementsMounted(reference, floating, update) {
    return autoUpdate(reference, floating, () => {
      const rect = reference.getBoundingClientRect();
      // 锚点可能因父级 hover 结束而临时 display:none。
      // 此时保留最后一次有效坐标，避免菜单跳到屏幕左上角。
      if (rect.width || rect.height) update();
    });
  },
});

const close = () => {
  open.value = false;
};

watch(open, (value) => emit('update:open', value));

// 点击外部关闭（排除触发按钮，否则点击触发按钮时 pointerdown 先关闭、
// 随后的 click 又 toggle 打开，导致菜单关不掉）
onClickOutside(menuRef, close, {
  ignore: [triggerRef],
});

// 组件销毁时强制关闭，防止 Teleport 遗留
onUnmounted(() => close());

// 暴露关闭方法给父组件
defineExpose({ close });
</script>

<template>
  <span
    ref="triggerRef"
    class="inline-flex items-center justify-center"
    :class="props.triggerClass"
    @click.stop="open = !open"
  >
    <slot name="trigger" :open="open" />
  </span>

  <Teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      class="z-50 min-w-16 rounded-2xl border border-gray-200 bg-white p-1 shadow-xl shadow-black/10"
      :class="[props.menuClass, { invisible: !isPositioned }]"
      :style="floatingStyles"
    >
      <div @click.stop="props.closeOnMenuClick && close()">
        <slot name="menu" />
      </div>
    </div>
  </Teleport>
</template>
