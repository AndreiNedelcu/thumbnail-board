import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import board from '../board-utils.js';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('async function confirmDelete()');
const fn=html.slice(start,html.indexOf('\n}\n',start)+3);
function harness(response){
  const elements=new Map();
  const c={_deleteIds:['a','b'],_deleteBusy:false,allVideos:[{id:'a'},{id:'b'},{id:'c'}],visibleVideos:[],selectedIds:new Set(['a','b']),favoriteIds:new Set(['a']),FAVORITES_KEY:'test',selectMode:true,calls:0,filters:0,modalOpen:true,
    document:{getElementById(id){if(!elements.has(id))elements.set(id,{});return elements.get(id);}},localStorage:{setItem(){}},TBBoard:board,
    TBApi:{async request(path,options){c.calls++;assert.equal(path,'/api/bulk-delete');assert.deepEqual(JSON.parse(options.body).ids,['a','b']);if(response instanceof Error)throw response;return response;}},
    hideDeleteConfirm(){c.modalOpen=false;},closeLightbox(){},toggleSelectMode(){c.selectMode=!c.selectMode;c.selectedIds.clear();},updateSelBar(){},applyFilters(){c.filters++;c.visibleVideos=c.allVideos;},showToast(){}};
  vm.createContext(c);vm.runInContext(fn,c);return c;
}
test('bulk success refreshes visible grid even when selection mode exits',async()=>{
  const c=harness({ok:true,deletedIds:['a','b']});await c.confirmDelete();
  assert.equal(c.calls,1);assert.deepEqual(c.visibleVideos.map(v=>v.id),['c']);assert.equal(c.filters,1);assert.equal(c.favoriteIds.size,0);assert.equal(c.modalOpen,false);
});
test('network failure keeps modal, selection and thumbnails for retry',async()=>{
  const c=harness(new Error('Connection lost'));await c.confirmDelete();
  assert.equal(c.calls,1);assert.equal(c.allVideos.length,3);assert.equal(c.selectedIds.size,2);assert.equal(c.modalOpen,true);assert.equal(c._deleteBusy,false);assert.equal(c.document.getElementById('confirm-error').textContent,'Connection lost');
});
test('partial confirmation removes only confirmed IDs and preserves remaining selection',async()=>{
  const c=harness({ok:true,deletedIds:['a']});await c.confirmDelete();
  assert.deepEqual(c.visibleVideos.map(v=>v.id),['b','c']);assert.deepEqual([...c.selectedIds],['b']);assert.equal(c.selectMode,true);
});
