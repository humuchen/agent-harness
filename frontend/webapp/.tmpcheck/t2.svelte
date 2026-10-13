<script lang="ts">
  let items: {id:number;name:string}[] = $state([{id:1,name:'a'}]);
  let cond = $state(true);
  let el: HTMLDivElement | undefined = $state();
  let child: { doThing?: (e: KeyboardEvent) => boolean } | undefined = $state();
  function onKey(e: KeyboardEvent) { if (child && typeof child.doThing === 'function' && child.doThing(e)) return; }
  const w = '54%';
</script>

{#snippet row(m: {id:number;name:string})}
  <div class="item {cond ? 'on' : ''}" style="--w:{w}" data-id={m.id} onclick={() => {}}>
    {m.name}
    {#if cond}<span class="x">y</span>{/if}
  </div>
{/snippet}

<div bind:this={el} onkeydown={onKey}>
  {#each items as m (m.id)}
    {@render row(m)}
  {/each}
  <input value={cond ? 'a' : 'b'} disabled={cond ? true : undefined} />
  <span aria-pressed={cond ? 'true' : 'false'}></span>
</div>
