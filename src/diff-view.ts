// Recorded unified patches, shared by tool results and the modified-files strip.
// Preview historical receipts directly; the current working tree is not their baseline.
export const DIFF_CSS = `
.diff-file{position:relative;min-width:0;border:1px solid var(--border);border-radius:6px;margin:4px 0;overflow:hidden;background:var(--bg)}
.activity-file.diff-file{padding:0}.tool-diff.diff-file{margin:4px 12px}
.diff-file .diff-summary{display:flex;align-items:center;gap:8px;min-height:32px;padding:5px 36px 5px 9px;cursor:pointer;list-style:none;font-size:12px;line-height:1.5}
.diff-summary::-webkit-details-marker{display:none}.diff-summary::before{content:'';width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);flex-shrink:0;color:var(--dim);margin-right:2px}
.diff-disclosure[open]>.diff-summary::before{transform:rotate(45deg);margin-top:-3px}.diff-summary:hover{background:var(--vscode-list-hoverBackground,#8881)}
.diff-path{min-width:0;flex:1;display:flex;align-items:baseline;gap:7px;overflow:hidden;font-family:var(--vscode-editor-font-family,monospace);font-size:11px}
.diff-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.diff-dir{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim);font-size:10px}
.diff-counts{display:inline-flex;gap:6px;flex-shrink:0;white-space:nowrap;font:11px var(--vscode-editor-font-family,monospace);font-variant-numeric:tabular-nums}
.diff-added{color:var(--vscode-gitDecoration-addedResourceForeground,var(--ok))}.diff-removed{color:var(--vscode-gitDecoration-deletedResourceForeground,var(--err))}.diff-badge{font:10px var(--vscode-font-family,system-ui,sans-serif);color:var(--dim)}
.diff-file>.diff-open{position:absolute;right:4px;top:4px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:4px;color:var(--dim)}.diff-open svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.diff-file pre.diff-code{--diff-column-width:max(4ch,var(--diff-digit-width,0ch));--diff-gutter-padding:6px;display:block;max-width:100%;max-height:320px;overflow:auto;overscroll-behavior:contain;overflow-anchor:none;margin:0;padding:5px 0;border:0;border-top:1px solid var(--border);border-radius:0;background:var(--vscode-editor-background,var(--bg));font:12px/1.65 var(--vscode-editor-font-family,monospace);tab-size:4;white-space:pre;overflow-wrap:normal;word-break:normal}
.diff-code:focus-visible{outline:1px solid var(--vscode-focusBorder,var(--accent));outline-offset:-1px}
.diff-line{display:inline-block;position:relative;vertical-align:top;width:max-content;min-width:100%;min-height:1.65em;padding-left:calc(2 * var(--diff-column-width) + 4 * var(--diff-gutter-padding) + 9px);white-space:pre}
.diff-gutter{position:absolute;left:0;top:0;height:100%;display:inline-flex;user-select:none;color:var(--vscode-editorLineNumber-foreground,var(--dim));border-right:1px solid var(--border);margin-right:8px;background:var(--vscode-editorGutter-background,transparent)}
.diff-gutter::before,.diff-gutter::after{width:var(--diff-column-width);min-width:var(--diff-column-width);text-align:right;padding:0 var(--diff-gutter-padding);box-sizing:content-box;font-variant-numeric:tabular-nums}.diff-gutter::before{content:attr(data-old)}.diff-gutter::after{content:attr(data-new)}
.diff-marker{display:inline-block;flex-shrink:0;width:1ch;user-select:text}.diff-source{padding-right:12px}
.diff-add{background:var(--vscode-diffEditor-insertedLineBackground,rgba(46,160,67,.15))}.diff-remove{background:var(--vscode-diffEditor-removedLineBackground,rgba(248,81,73,.15))}
.diff-add .diff-marker{color:var(--vscode-gitDecoration-addedResourceForeground,var(--ok))}.diff-remove .diff-marker{color:var(--vscode-gitDecoration-deletedResourceForeground,var(--err))}
.diff-hunk{color:var(--vscode-textLink-foreground,var(--accent));background:var(--vscode-diffEditor-unchangedRegionBackground,#8881)}.diff-meta,.diff-raw{color:var(--dim)}
.diff-note,.diff-empty,.diff-notice{padding:5px 9px;font-size:10px;line-height:1.5;color:var(--dim);overflow-wrap:anywhere}.diff-empty{padding:12px 10px;font-size:11px;border-top:1px solid var(--border)}.diff-notice{color:var(--warn);border-top:1px solid var(--border)}
.diff-provenance{font-size:10px;color:var(--dim);padding:5px 3px 2px;line-height:1.5}.diff-caption{font-size:10px;color:var(--dim);margin:8px 12px 4px}.diff-section-counts{margin-left:8px}#fileSummary{font-size:11px}#fileList{overflow-anchor:none}
@media(max-width:480px){.diff-dir{display:none}.diff-file .diff-summary{gap:6px}.diff-file pre.diff-code{font-size:11px;--diff-column-width:max(3ch,var(--diff-digit-width,0ch));--diff-gutter-padding:4px}}
`;

export const DIFF_CLIENT_JS = String.raw`
  function validDiffCount(value){return Number.isSafeInteger(value)&&value>=0;}
  function diffFiles(document){
    if(!document||!Array.isArray(document.files))return [];
    return document.files.filter(function(file){return file&&typeof file==='object'&&!Array.isArray(file)&&typeof file.path==='string'&&file.path.length;}).map(function(file){return {path:file.path,added:validDiffCount(file.added)?file.added:undefined,removed:validDiffCount(file.removed)?file.removed:undefined,binary:file.binary===true,patch:typeof file.patch==='string'?file.patch:undefined,truncated:document.truncated===true};});
  }
  function diffCountsHtml(file){
    if(file.binary)return '<span class="diff-badge">binary</span>';
    var added=validDiffCount(file.added)?String(file.added):'?',removed=validDiffCount(file.removed)?String(file.removed):'?';
    return '<span class="diff-counts" aria-label="'+added+' lines added, '+removed+' lines removed"><span class="diff-added">+'+added+'</span><span class="diff-removed">−'+removed+'</span></span>';
  }
  function diffTotalsHtml(files){
    var added=0,removed=0,knownAdded=true,knownRemoved=true;
    files.forEach(function(file){if(validDiffCount(file.added)&&Number.isSafeInteger(added+file.added))added+=file.added;else knownAdded=false;if(validDiffCount(file.removed)&&Number.isSafeInteger(removed+file.removed))removed+=file.removed;else knownRemoved=false;});
    return diffCountsHtml({added:knownAdded?added:undefined,removed:knownRemoved?removed:undefined});
  }
  function parseUnifiedDiff(patch){
    var source=patch.split(/\r?\n/);if(source[source.length-1]===''&&/\n$/.test(patch))source.pop();
    var rows=[],oldLine=0,newLine=0,oldLeft=0,newLeft=0,active=false,incomplete=false,unrecognized=false;
    source.forEach(function(text){
      var row={text:text,kind:'meta'},match=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(text);
      if(match){
        if(active&&(oldLeft||newLeft))incomplete=true;
        var oldStart=Number(match[1]),oldCount=match[2]===undefined?1:Number(match[2]),newStart=Number(match[3]),newCount=match[4]===undefined?1:Number(match[4]);
        if([oldStart,oldCount,newStart,newCount].every(validDiffCount)&&(!oldCount||oldStart>0)&&(!newCount||newStart>0)&&Number.isSafeInteger(oldStart+oldCount)&&Number.isSafeInteger(newStart+newCount)){
          oldLine=oldStart;newLine=newStart;oldLeft=oldCount;newLeft=newCount;active=true;row.kind='hunk';
        }else{active=false;incomplete=true;row.kind='raw';}
      }else if(text==='\\ No newline at end of file'){
        row.kind='meta';
      }else if(active&&(oldLeft||newLeft)){
        var sign=text[0];
        if((sign===' '||text==='')&&oldLeft>0&&newLeft>0){row.kind='context';row.old=oldLine++;row.next=newLine++;oldLeft--;newLeft--;}
        else if(sign==='-'&&oldLeft>0){row.kind='remove';row.old=oldLine++;oldLeft--;}
        else if(sign==='+'&&newLeft>0){row.kind='add';row.next=newLine++;newLeft--;}
        else{row.kind='raw';incomplete=true;active=false;}
      }else if(/^@@/.test(text)){
        row.kind='raw';incomplete=true;active=false;
      }else if(!/^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch|literal \d|delta \d)/.test(text)&&text!==''){
        row.kind='raw';unrecognized=true;
      }
      rows.push(row);
    });
    if(active&&(oldLeft||newLeft))incomplete=true;
    return {rows:rows,incomplete:incomplete,unrecognized:unrecognized};
  }
  function diffLinesHtml(parsed){
    return parsed.rows.map(function(row){
      var numbered=row.kind==='add'||row.kind==='remove'||row.kind==='context',sign=numbered?(row.text[0]||''):'',text=numbered?row.text.slice(1):row.text;
      return '<span class="diff-line diff-'+row.kind+'"><span class="diff-gutter" aria-hidden="true" data-old="'+(row.old===undefined?'':row.old)+'" data-new="'+(row.next===undefined?'':row.next)+'"></span><span class="diff-marker">'+esc(sign)+'</span><span class="diff-source">'+esc(text)+'</span></span>';
    }).join('\n');
  }
  function diffParseNotice(parsed){
    return parsed.incomplete?'Recorded patch is incomplete or malformed; unparsed lines are shown without line numbers.':parsed.unrecognized?'Unrecognized patch lines are shown without line numbers.':'';
  }
  function diffPatchHtml(file,key){
    var html=file.truncated?'<div class="diff-notice">Nodecode marked this recorded change as truncated.</div>':'';
    if(!file.patch)return html+'<div class="diff-empty">'+(file.binary?'Binary file changed · no text preview':'No textual patch was recorded for this change.')+'</div>';
    // Closed files keep one text node instead of thousands of offscreen line elements.
    return html+'<pre class="diff-code" tabindex="0" data-diff-pending data-diff-scroll="'+esc(key)+'" aria-label="Recorded diff for '+esc(file.path)+'">'+esc(file.patch)+'</pre>';
  }
  function hydrateDiff(pane){
    if(!pane.hasAttribute('data-diff-pending'))return;
    var parsed=parseUnifiedDiff(pane.textContent),notice=diffParseNotice(parsed);
    var digits=parsed.rows.reduce(function(width,row){return Math.max(width,String(row.old||'').length,String(row.next||'').length);},1);
    pane.style.setProperty('--diff-digit-width',digits+'ch');pane.innerHTML=diffLinesHtml(parsed);pane.removeAttribute('data-diff-pending');
    if(notice){var note=document.createElement('div');note.className='diff-notice';note.textContent=notice;pane.after(note);}
  }
  function diffFileHtml(file,key,classes,note){
    var slash=Math.max(file.path.lastIndexOf('/'),file.path.lastIndexOf('\\')),name=file.path.slice(slash+1)||file.path,directory=slash>=0?file.path.slice(0,slash):'';
    return '<div class="diff-file '+classes+'" data-file-path="'+esc(file.path)+'"><details class="diff-disclosure" data-detail="'+esc(key)+'" data-diff-key="'+esc(key)+'"><summary class="diff-summary" aria-expanded="false" title="'+esc(file.path)+'"><span class="diff-path"><span class="diff-name">'+esc(name)+'</span>'+(directory?'<span class="diff-dir">'+esc(directory)+'</span>':'')+'</span>'+diffCountsHtml(file)+'</summary>'+(note?'<div class="diff-note">'+esc(note)+'</div>':'')+diffPatchHtml(file,key)+'</details><button class="diff-open" data-a="openChangedFile" data-p="'+esc(file.path)+'" aria-label="Open file '+esc(file.path)+'" title="Open current workspace file · '+esc(file.path)+'"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/></svg></button></div>';
  }
  function rememberDiffFocus(root){
    var active=document.activeElement,file=root.contains(active)&&active.closest('.diff-file');
    if(!file)return null;return {node:active,key:file.querySelector('[data-diff-key]').dataset.diffKey,kind:active.tagName==='SUMMARY'?'summary':active.matches('.diff-code')?'pre':active.dataset.a==='openChangedFile'?'button':null};
  }
  function restoreDiffFocus(root,savedFocus){
    if(!savedFocus||document.activeElement===savedFocus.node||!savedFocus.kind)return;
    var details=Array.from(root.querySelectorAll('[data-diff-key]')).find(function(node){return node.dataset.diffKey===savedFocus.key;});
    if(details){var target=savedFocus.kind==='button'?details.parentElement.querySelector('.diff-open'):details.querySelector(savedFocus.kind);if(target)target.focus({preventScroll:true});}
  }
  function restoreDiffState(root){
    root.querySelectorAll('[data-diff-key]').forEach(function(details){details.open=!!expanded[details.dataset.diffKey];details.querySelector('summary').setAttribute('aria-expanded',String(details.open));});
    root.querySelectorAll('[data-diff-scroll]').forEach(function(pane){if(!pane.closest('details:not([open])')&&pane.getClientRects().length){hydrateDiff(pane);if(!pane._diffRestored){var position=diffScroll[pane.dataset.diffScroll];if(position){pane.scrollTop=position[0];pane.scrollLeft=position[1];}pane._diffRestored=true;}}});
  }
`;
