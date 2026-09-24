import {test} from 'node:test';
import assert from 'node:assert/strict';
import board from '../board-utils.js';
import {rotate,selectDiverse} from '../supabase/functions/_shared/scrape.mjs';
test('own channel filter covers both names and original channel tags',()=>{
  for(const video of [{channel:'TheSeniorDev'},{channelHandle:'@theSeniorDevPodcast'},{tags:['channel-theseniordev-main']}])assert.equal(board.isOwnChannel(video),true);
  assert.equal(board.isOwnChannel({channel:'Other Developer'}),false);
});
test('full views prefer permanent images, grids load full-resolution YouTube images with archive fallback, unsafe URLs are rejected',()=>{
  assert.equal(board.imageSources({id:'abcdefghijk',thumbnailUrl:'https://archive.test/img.jpg'})[0],'https://archive.test/img.jpg');
  assert.ok(board.imageSources({id:'abcdefghijk',thumbnailUrl:'javascript:alert(1)'})[0].startsWith('https://img.youtube.com'));
  assert.equal(board.channelUrl({channelUrl:'https://youtube.com.evil.test/'}),'');
  const grid=board.imageSources({id:'abcdefghijk',thumbnailUrl:'https://archive.test/img.jpg'},true);
  assert.deepEqual(grid.slice(0,2),['https://img.youtube.com/vi/abcdefghijk/maxresdefault.jpg','https://archive.test/img.jpg']);
});
test('partial deletions do not silently remove unconfirmed thumbnails',()=>{
  assert.deepEqual(board.confirmedDeletedIds({ok:true,deletedIds:['a','other']},['a','b']),['a']);
  assert.throws(()=>board.confirmedDeletedIds({ok:true,deleted:1},['a','b']));
  assert.throws(()=>board.confirmedDeletedIds({ok:false},['a']));
});
test('collector rotates beyond fixed channels and caps repeated channels/images',()=>{
  assert.notDeepEqual(rotate(['a','b','c','d'],2,0),rotate(['a','b','c','d'],2,1));
  const items=[{id:'a',channel:'One',outlierScore:10},{id:'b',channel:'One',outlierScore:9},{id:'c',channel:'Two',imageHash:'same',outlierScore:8},{id:'d',channel:'Three',imageHash:'same',outlierScore:7}];
  assert.deepEqual(selectDiverse(items,10,1).map(v=>v.id),['a','c']);
  assert.deepEqual(selectDiverse(items,0),[]);
});
