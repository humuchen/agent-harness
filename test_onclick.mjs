// Simulate how lit-html processes the HTML string
// lit-html creates a <template>, sets innerHTML, then imports nodes via importNode
// The question is: does importNode / template parsing correctly decode &lt; in attribute values?

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function selectAllBox() {
  const js = `var cb=document.querySelectorAll('.memo-mgmt-chk');for(var i=0;i<cb.length;i++){cb[i].checked=this.checked}`;
  return `<input type="checkbox" class="memo-mgmt-all" title="全选" onclick="${esc(js)}">`;
}

const html = selectAllBox();
console.log('Rendered HTML:', html);

// Now simulate what happens when this is placed in a lit-html template context:
// The template string contains this HTML as a part of a larger string
// When lit-html renders, it sets innerHTML on a container

// Test 1: Direct innerHTML
const container = document.createElement('div');
container.innerHTML = html;
const input = container.querySelector('input');
console.log('\nAfter innerHTML processing:');
console.log('onclick attr:', input.getAttribute('onclick'));
console.log('Decoded JS:');
// Browser automatically decodes entities in attribute values
const onclick = input.onclick;
console.log('onclick function:', onclick ? onclick.toString() : 'null/undefined');

// Test 2: What does the decoded JS look like?
const decoded = html.match(/onclick="([^"]*)"/)[1]
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
console.log('Manually decoded JS:', decoded);
