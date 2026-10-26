// References are opt-in spans selected from autocomplete, not arbitrary @words.
export const INLINE_REFERENCE_JS = String.raw`
  function reconcileInlineReferences(){
    var next=composer.value,previous=referenceText,start=0;
    while(start<previous.length&&start<next.length&&previous[start]===next[start])start++;
    var oldEnd=previous.length,newEnd=next.length;
    while(oldEnd>start&&newEnd>start&&previous[oldEnd-1]===next[newEnd-1]){oldEnd--;newEnd--;}
    var actual=referenceEdit,precise=false;referenceEdit=null;
    if(actual&&actual.text===previous){
      var editStart=actual.start,editEnd=actual.end;
      if(editStart===editEnd&&actual.type.startsWith('delete')){
        if(actual.type.endsWith('Backward'))editStart=composer.selectionStart;
        else editEnd=editStart+previous.length-next.length;
      }
      var replacementEnd=editEnd+next.length-previous.length;
      if(editStart>=0&&editEnd>=editStart&&replacementEnd>=editStart&&previous.slice(0,editStart)===next.slice(0,editStart)&&previous.slice(editEnd)===next.slice(replacementEnd)){start=editStart;oldEnd=editEnd;newEnd=replacementEnd;precise=true;}
    }
    var shift=newEnd-oldEnd;
    inlineRefs=inlineRefs.flatMap(function(ref){
      var copy={path:ref.path,start:ref.start,end:ref.end},token='@'+ref.path;
      // A programmatic replacement has no selection provenance. Repeated-token
      // deletion must not silently transfer approval to an unselected copy.
      if(!precise&&next.length<previous.length&&previous.split(token).length>next.split(token).length&&previous.indexOf(token)!==previous.lastIndexOf(token))return [];
      if(previous!==next){if(copy.end<=start){}else if(copy.start>=oldEnd){copy.start+=shift;copy.end+=shift;}else return [];}
      if(next.slice(copy.start,copy.end)!=='@'+copy.path)return [];
      if(copy.start>0&&!/\s/.test(next[copy.start-1]))return [];
      if(copy.end<next.length&&!/[\s,.;:!?)]/.test(next[copy.end]))return [];
      return [copy];
    });
    referenceText=next;files=Array.from(new Set(inlineRefs.map(function(ref){return ref.path;})));
  }
`;
