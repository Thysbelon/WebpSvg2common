// TODO (maybe): add feature to set a resolution for SVGs? For example, user can set '1000', and an SVG that's 82x41 will be output to 1000x500 (aspect ratio is preserved. 1000 / 82 = 12.195121951, 12.195121951 * 41 = 500 after rounding)
// TODO: only load webpinfo and anim_dump when they are needed.
// TODO: optimize code by using more web workers

async function convertFileList(fileList) {
	for (const file of fileList) {
		console.info(file.name);
		if (file.name.includes('.svg')) {
			await convertStillImage(file) // it's fine to not put await on these; but rather than converting every image asynchronously, it would be better to spawn a web worker for each image.
		} else {
			// load webpinfo here.
			let isAnim=await runWebpInfo(file)
			if (isAnim.includes('Animation: 1')) {
				const webpInfoText=isAnim;
				await convertAnimatedWebp(file, webpInfoText);
			} else {
				await convertStillImage(file)
			}
		}
	}
}

async function convertAnimatedWebp(file, webpInfoText){
	// TODO: load anim_dump here.
	// TODO: perform steps 'parse webpInfoText' and 'run anim_dump' at the same time using web workers
	
	// parse webpInfoText. take the webp anim info and convert it to gif anim info.
	const animInfo={
		repeat: parseInt(webpInfoText.replace(/.*Loop count *: (\d*).*/gms, '$1')),
		frameData:[]
	}
	console.debug(animInfo.background);
	console.debug(animInfo.repeat);
	const webpFrameInfoText=webpInfoText.replace(/^.*?(?=Chunk ANMF)(.*)/gms, '$1').replace('\nNo error detected.', '');
	console.debug(webpFrameInfoText);
	let tempFrameData=webpFrameInfoText.replaceAll('Chunk ANMF', '\uE000Chunk ANMF').split('\uE000');
	tempFrameData.shift()
	console.debug(tempFrameData);
	for (const frame of tempFrameData) {
		newFrame={
			delay: parseInt(frame.replace(/.*Duration: (\d*?)\n.*/gms, '$1')),
			dispose: parseInt(frame.replace(/.*Dispose: (\d*?)\n.*/gms, '$1'))==1/*dispose*/ ? 2/*dispose*/ : 1/*not dispose*/
		}
		animInfo.frameData.push(newFrame);
	}
	console.debug(animInfo);
	
	// run anim_dump
	const imageSequence=[]; //an array of blobs of the images dumped by anim_dump
	{ // scope temporary variables
		const imgArrayBuf=await file.arrayBuffer()
		const module = {
			arguments: ["input.webp"],
			preRun: () => {
				module.FS.writeFile("input.webp", new Uint8Array(imgArrayBuf));
			},
			postRun: () => {
				for (let i=0, l=animInfo.frameData.length; i<l; i++) { // TODO: check if it's possible for there to be more than 4 leading zeroes.
					imageSequence[i]=new Blob([module.FS.readFile('dump_'+i.toString().padStart(4, '0')+'.png', {encoding: "binary"})]);
				}
			},
		};
		await AnimDump(module);
	}
	
	// encode gif
	//import { GIFEncoder, quantize, applyPalette } from 'https://unpkg.com/gifenc';
	const gifenc=await import('https://unpkg.com/gifenc');
	{
		const inputimg = document.createElement("img");
		await loadImageIntoElem(inputimg, imageSequence[0])
		var canvas = new OffscreenCanvas(inputimg.naturalWidth, inputimg.naturalHeight);
		var ctx = canvas.getContext("2d");
		ctx.fillStyle = "#0f0";
		// https://stackoverflow.com/a/45122479/20697953
		ctx.drawImage(inputimg, 0, 0);
		const isFrameTransparent=hasAlpha(ctx, canvas);
		// TODO: write a function that searches for solid green pixels; if any are found, use pink as a backup transparent color
		ctx.fillRect(0,0,canvas.width,canvas.height)
		ctx.drawImage(inputimg, 0, 0);
		const imageData=ctx.getImageData(0,0,canvas.width,canvas.height);
		const rawImageData=imageData.data;
		gifenc.prequantize(rawImageData, { roundRGB: 1 });
		var palette = gifenc.quantize(rawImageData, 256 /*, {format: animInfo.transparent ? 'rgba4444' : 'rgb565',}*/);
		//var transparentIndex = animInfo.transparent ? palette.findIndex((p) => p[3] === 0) : 0;
		var transparentIndex = isFrameTransparent ? gifenc.nearestColorIndex(palette, [0,255,0]) : 0;
		const index = gifenc.applyPalette(rawImageData, palette);
		var gif = gifenc.GIFEncoder();
		gif.writeFrame(index, canvas.width, canvas.height, { palette: palette, delay: animInfo.frameData[0].delay, dispose: animInfo.frameData[0].dispose, transparent: isFrameTransparent, transparentIndex: transparentIndex, repeat: animInfo.repeat});
	}
	for (let i=1, l=animInfo.frameData.length; i<l; i++) {
		console.debug('frame '+i);
		const inputimg = document.createElement("img");
		await loadImageIntoElem(inputimg, imageSequence[i])
		ctx.clearRect(0,0,canvas.width,canvas.height)
		ctx.drawImage(inputimg, 0, 0);
		const isFrameTransparent=hasAlpha(ctx, canvas);
		ctx.fillRect(0,0,canvas.width,canvas.height)
		ctx.drawImage(inputimg, 0, 0);
		const imageData=ctx.getImageData(0,0,canvas.width,canvas.height);
		const rawImageData=imageData.data;
		const index = gifenc.applyPalette(rawImageData, palette);
		gif.writeFrame(index, canvas.width, canvas.height, {delay: animInfo.frameData[i].delay, dispose: animInfo.frameData[i].dispose, transparent: isFrameTransparent, transparentIndex: transparentIndex});
	}
	gif.finish();
	download(new Blob([gif.bytes()]), file.name.replace('.webp', '.gif'));
}

// https://stackoverflow.com/a/45122479/20697953
function hasAlpha (context, canvas) {
	var data = context.getImageData(0, 0, canvas.width, canvas.height).data,
		hasAlphaPixels = false;
	for (var i = 3, n = data.length; i < n; i+=4) {
		if (data[i] < 255) {
			hasAlphaPixels = true;
			break;
		}
   }
   return hasAlphaPixels;
}


async function runWebpInfo(file){
	var imgArrayBuf=await file.arrayBuffer()
	var printLog='';
	const module = {
		arguments: ["input.webp"],
		preRun: () => {
			module.FS.writeFile("input.webp", new Uint8Array(imgArrayBuf));
		},
		postRun: () => {
			console.log(printLog);
		},
		print: function(text) {
			printLog+=text+'\n';
		}
	};
	await WebpInfo(module);
	return printLog;
}

async function convertStillImage(file){
	// https://stackoverflow.com/questions/56446481/how-to-save-webp-image-as-another-type
	var inputimg = document.createElement("img");
	console.log(await loadImageIntoElem(inputimg, file));
	if (file.name.includes('.svg')) {
		let svgText=await file.text();
		let svgWidth=parseInt(svgText.replace(/.*viewBox=..*? .*? (.*?) .*/gm, '$1'));
		let svgHeight=parseInt(svgText.replace(/.*viewBox=..*? .*? .*? (.*?)['"].*/gm, '$1'));
		console.log('svgWidth: '+svgWidth+', svgHeight: '+svgHeight)
		var canvas = new OffscreenCanvas(svgWidth, svgHeight);
	} else {
		console.log('inputimg.naturalWidth: '+inputimg.naturalWidth+', inputimg.naturalHeight: '+inputimg.naturalHeight)
		var canvas = new OffscreenCanvas(inputimg.naturalWidth, inputimg.naturalHeight);
	}
	var ctx = canvas.getContext("2d"); 
	console.log('canvas.width: '+canvas.width+', canvas.height: '+canvas.height)
	ctx.drawImage(inputimg, 0, 0, /* for SVGs */ canvas.width, canvas.height);
	inputimg=null;
	outputBlob=await canvas.convertToBlob();
	download(outputBlob, file.name.replace('.webp', '.png').replace('.svg', '.png'))
}

function loadImageIntoElem(inputimg, file) {
	return new Promise(function(resolve, reject){
		inputimg.addEventListener('load', function(){resolve(true)}, {once:true});
		inputimg.src=URL.createObjectURL(file)
	})
}

function download(blob, name) {
	const link = document.createElement('a')
	const url = URL.createObjectURL(blob)
	
	link.href = url
	link.download = name
	document.body.appendChild(link)
	link.click()
	
	document.body.removeChild(link)
	window.URL.revokeObjectURL(url)
}