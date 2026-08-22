(() => {
  const root = document.getElementById('n6-lab');
  const fixedCost = 4808;
  const LAB = window.__N6_LAB__;
  if (!LAB) throw new Error('N6 lab boot data missing — load /src/lab/boot.ts first');
  const PROFILE = LAB.profile;
  const CASE_GEO = LAB.caseGeometry;
  const BOARD = LAB.boardStorage;
  // Millimetre values live in geometry.json / profile.json, SATA port counts on the
  // board SKU. Nothing here restates them; this object only names the ones the UI
  // copy refers to. The SATA ceiling is deliberately absent: it moves with the NVMe
  // count, so it is asked for per config via sataCeiling(), never frozen here.
  const limits = Object.freeze({
    trays:PROFILE.trayCount,
    onboardSata:BOARD.nativeSata,
    slimSata:BOARD.slimsasSata,
    m2Slots:BOARD.m2Slots,
    psuMm:{atxMax:PROFILE.psuLimits.atxMaxLengthMm,sfxMax:PROFILE.psuLimits.sfxMaxLengthMm},
    coolerMm:{overheadPsu:PROFILE.coolerLimits.overheadAtxMm,openTop:PROFILE.coolerLimits.openTopMm},
    gpuMm:{publishedMin:PROFILE.gpuLimits.planningMinMm,publishedMax:PROFILE.gpuLimits.publishedMaxMm},
    chassisFanHeaders:3
  });
    const psus = LAB.psus;
    const coolers = LAB.coolers;
    const gpus = LAB.gpus;
    const rams = LAB.rams;
  const accessories = {
    boot:{name:'240–500GB SATA 启动 SSD',price:[120,260],mid:180,default:true,why:'TrueNAS 启动盘独占，避免浪费 980 PRO。'},
    usbboot:{name:'外置 USB 3.x 启动 SSD',price:[180,450],mid:280,default:false,why:'9 HDD 模式腾出第 9 托架；需要固定短线并接受外接链路风险。'},
    front:{name:'2×140mm PWM 前进风',price:[100,420],mid:140,default:true,why:'ATX 下压风冷只有 8–12mm 余隙，前进风很重要。'},
    rearfan:{name:'1×120mm PWM 后排风',price:[60,180],mid:99,default:false,why:'只在后上位没有 ATX 电源时规划；SFX + 塔式风冷路线更有价值。'},
    sidefans:{name:'2×120mm PWM GPU / HBA 侧吹',price:[80,320],mid:140,default:false,why:'对被动 HBA 或 200W 级 GPU 提供定向气流；下置 SFX 时只能按未拆的一侧规划。'},
    drivefans:{name:'2×120mm PWM 盘区风扇',price:[80,320],mid:140,default:false,why:'N6 只标注安装位，不能默认随箱附送；企业盘需要持续低速气流。'},
    splitter:{name:'PWM 一分二 / 风扇集线器',price:[25,80],mid:45,default:true,why:'前、硬盘舱、未来侧风扇分组三路控制。'},
    psucable:{name:'补齐同型号 PSU 外围线（1–2 条）',price:[80,360],mid:180,default:true,why:'N6 手册建议背板四口各一条独立线；数量随 PSU 原盒清单变化，必须核对模组针脚。电源侧 SATA/PATA 插座已占满的型号（如 Corsair SF 系列只有 3 个）加线也插不上，此项不计入。'},
    dualsfx:{name:'第二颗 450–650W SFX 背板电源',price:[499,899],mid:699,default:false,why:'仅双电源拓扑自动计入；增加布线和待机损耗，不形成服务器式冗余。'},
    dualsync:{name:'双电源 PS_ON 同步模块 / 继电器',price:[60,180],mid:100,default:false,why:'让第二颗背板电源随主机启停；具体模块额定值、接法和故障模式必须核对。'},
    dualcables:{name:'第二颗 SFX 背板专用线束补齐预留',price:[160,360],mid:240,default:false,why:'双电源时四个背板口必须全部来自专用背板 PSU，不能把主电源线束数量相加。'},
    slim:{name:'SlimSAS → 4×SATA 线',price:[80,180],mid:120,default:false,why:'第 5–8 块盘使用；接口与线序需按主板手册。'},
    hba:{name:'LSI 9300-8i IT Mode + 2 条分线',price:[380,650],mid:480,default:false,why:'9 数据盘或希望统一走 HBA 时需要；增加约 8–15W。'},
    vibration:{name:'软木橡胶复合垫 / 脚垫',price:[30,100],mid:55,default:true,why:'隔离桌面共振，不能遮挡机箱进风。'},
    hardware:{name:'N6 原配螺丝、10 个垫片与 5 根扎带',price:[0,0],mid:0,default:true,why:'手册配件页已列出；先核对你的箱内清单，不重复购买。不要用海绵包盘。'},
    ups:{name:'1000–1500VA 线互动 UPS',price:[900,1800],mid:1300,default:false,why:'停电时让 TrueNAS 安全关机；不是电源双机冗余。'},
    mat:{name:'防静电腕带 / 磁吸螺丝盘',price:[25,80],mid:45,default:false,why:'装机便利，不影响运行。'}
  };
    const officialProducts = LAB.officialProducts;
  const state = {selectedAccessories:new Set(['boot','front','splitter','psucable','vibration','hardware'])};
  const $ = s => root.querySelector(s);
  const $$ = s => [...root.querySelectorAll(s)];
  const fmt = n => '¥'+Math.round(n).toLocaleString('zh-CN');
  const range = p => p[0]===p[1] ? fmt(p[0]) : `${fmt(p[0])}–${fmt(p[1])}`;
  const logSum = vals => vals.length ? 10*Math.log10(vals.reduce((a,v)=>a+Math.pow(10,v/10),0)) : 0;
  const interp = (points, x) => {
    if (x <= points[0][0]) return points[0][1] * x / points[0][0];
    for (let i=1;i<points.length;i++) if (x <= points[i][0]) { const [x0,y0]=points[i-1],[x1,y1]=points[i]; return y0+(y1-y0)*(x-x0)/(x1-x0); }
    return x/.92;
  };
  const curves = {
    'psu.seasonic-focus-gx-850-v5':[[17,25.174],[20.013,28.474],[40.009,49.235],[60.008,70.04],[79.979,90.806],[169.987,185.519],[255.004,275.096],[340.103,365.397],[425.169,457.058]],
    'psu.seasonic-focus-gx-750-v5':[[15,24.395],[20.016,29.572],[40.009,50.197],[60.005,70.796],[79.971,91.428],[149.969,164.651],[224.978,243.026],[300.07,322.379],[374.684,402.208]]
  };

  function readConfig(){
    const psuKey=$('#psu-select').value,secondaryPsuKey=$('#secondary-psu-select').value,coolerKey=$('#cooler-select').value,gpuKey=$('#gpu-select').value,ramKey=$('#ram-select').value;
    const disks=+$('#disk-range').value,ambient=+$('#ambient-range').value,[pl1,pl2]=$('#pl-select').value.split('-').map(Number);
    const psuPosition=$('#psu-position').value,cooler=coolers[coolerKey],frontSfx=psus[psuKey].form==='SFX'&&psuPosition!=='bottom';
    const frontRequested=cooler.fit==='front240'||$('#front-fans').checked,front=frontRequested&&!frontSfx;
    const num=(id,fallback,min,max)=>Math.max(min,Math.min(max,Number($('#'+id).value)||fallback));
    const customGpuPrice=num('gpu-custom-price',0,0,100000),gpu=gpuKey==='custom'?{name:$('#gpu-custom-name').value.trim()||'自定义 GPU 包络',kind:'用户包络',vram:num('gpu-custom-vram',16,0,96),tgp:num('gpu-custom-tgp',180,0,600),idle:Math.max(5,Math.round(num('gpu-custom-tgp',180,0,600)*.07)),length:num('gpu-custom-length',250,120,340),slots:num('gpu-custom-slots',2,1,4),noise:40,price:[customGpuPrice,customGpuPrice],mid:customGpuPrice,official:'用户输入尺寸/预算；官方价与历史价仍需按具体 SKU 核验',cooling:'按具体 SKU 核对',ai:'自定义包络只用于尺寸、功耗与插槽规划',specificGeometry:true,userEnvelope:true}:gpus[gpuKey];
    return {psuKey,secondaryPsuKey,coolerKey,gpuKey,ramKey,psuPosition,psu:psus[psuKey],secondaryPsu:psus[secondaryPsuKey],dualStart:$('#dual-start-select').value,cooler,gpu,ram:rams[ramKey],disks,ambient,pl1,pl2,boot:$('#boot-select').value,nvme:+$('#nvme-select').value,hbaMode:$('#hba-select').value,fan:$('#fan-select').value,workload:$('#workload-select').value,frontRequested,front,rear:$('#rear-fan').checked,drive:$('#drive-fans').checked,side:$('#side-fans').checked,preserve:$('#preserve-hba').checked};
  }
  function frontSfxSelected(){
    const psu=psus[$('#psu-select').value],position=$('#psu-position').value;
    return psu.form==='SFX'&&position!=='bottom';
  }
  function sataDeviceCount(c){return c.disks+(c.boot==='bay'?1:0);}
  function ramModuleCount(c){return c.ram.modules||1;}
  function sataCeiling(c){return LAB.sataCeiling(c.nvme);}
  function hasHba(c){ return c.hbaMode==='always' || sataDeviceCount(c)>sataCeiling(c); }
  function backplaneHarnessCount(c){return c.psuPosition==='dual'?c.secondaryPsu.harness:c.psu.harness;}
  function psuPlacement(c){
    if(c.psuPosition==='dual')return c.psu.form==='ATX'?'rearUpperATX_plus_bottomSFX':'frontSFX_plus_bottomSFX';
    if(c.psuPosition==='bottom')return c.psu.form==='SFX'?'bottomSFX':'invalidATXBottom';
    return c.psu.form==='ATX'?'rearUpperATX':'frontSFX';
  }
  function overheadPsu(c){ return ['rearUpperATX','rearUpperATX_plus_bottomSFX','invalidATXBottom'].includes(psuPlacement(c)); }
  function rearFanAvailable(c){return !overheadPsu(c);}
  function frontBlocked(c){ return ['frontSFX','frontSFX_plus_bottomSFX'].includes(psuPlacement(c))||c.cooler.fit==='front240'||c.frontRequested; }
  function coolerPlanningLimit(c){ return overheadPsu(c)?limits.coolerMm.overheadPsu:limits.coolerMm.openTop; }
  function gpuPlanningLimit(){ return limits.gpuMm.publishedMax; }
  function caseFanGroupCount(c){return (c.front?1:0)+(c.rear?1:0)+(c.drive?1:0)+(c.side?1:0);}
  function topologyLabel(c){return ({rearUpperATX:'ATX 后上置',frontSFX:'SFX 前置',bottomSFX:'SFX 后下置',rearUpperATX_plus_bottomSFX:'ATX 后上 + SFX 后下',frontSFX_plus_bottomSFX:'SFX 前置 + SFX 后下',invalidATXBottom:'无效：ATX 不能下置'})[psuPlacement(c)];}
  function wallForPsu(psuKey,dc){
    if(dc<=0)return 0;
    if(curves[psuKey])return interp(curves[psuKey],dc);
    const eff=psuKey==='psu.corsair-sf750-atx31'?(dc<40?.77:dc<80?.84:.92):psuKey==='psu.sfx-450-unlocked'?(dc<40?.72:dc<80?.80:.87):(dc<40?.74:dc<80?.81:.89);
    return dc/eff;
  }
  function wallForLoads(c,mainDc,driveDc=0){return wallForPsu(c.psuKey,mainDc)+(c.psuPosition==='dual'?wallForPsu(c.secondaryPsuKey,driveDc):0);}
  function wallFor(c,dc){return wallForPsu(c.psuKey,dc);}
  function powerModel(c){
    const dual=c.psuPosition==='dual',hba=hasHba(c)?12:0,hddIdle=c.disks*6.22,hddWork=c.disks*8.5,fanW=5+(c.front?4:0)+(c.rear?2:0)+(c.drive?4:0)+(c.side?4:0),base=23+fanW+(dual&&c.dualStart==='sync'?1:0);
    let cpu=12,hdd=hddIdle,gpu=c.gpu.idle;
    if(c.workload==='read'){cpu=22;hdd=hddWork;}
    if(c.workload==='quicksync'){cpu=45;hdd=hddWork;}
    if(c.workload==='cpu'){cpu=c.pl1;hdd=hddWork;}
    if(c.workload==='ai'){cpu=c.gpu.tgp?25:c.pl1;gpu=c.gpu.tgp;hdd=hddWork;}
    if(c.workload==='combined'){cpu=c.pl2;gpu=c.gpu.tgp;hdd=hddWork;}
    const mainDc=base+cpu+gpu+hba+(dual?0:hdd),driveDc=dual?hdd+2:0,dc=mainDc+driveDc;
    const mainWall=wallForPsu(c.psuKey,mainDc),driveWall=dual?wallForPsu(c.secondaryPsuKey,driveDc):0,wall=mainWall+driveWall;
    const mainPeak=35+c.pl2+c.gpu.tgp+hba,drivePeak=15+c.disks*33.1,pathological=mainPeak+drivePeak;
    const pathologicalWall=dual?wallForLoads(c,mainPeak,drivePeak):wallForPsu(c.psuKey,pathological);
    const headroom=dual?Math.min((c.psu.watts-mainPeak)/c.psu.watts,(c.secondaryPsu.watts-drivePeak)/c.secondaryPsu.watts):(c.psu.watts-pathological)/c.psu.watts;
    const psuWaste=psuWasteHeatW(c.psu,mainDc)+(dual?psuWasteHeatW(c.secondaryPsu,driveDc):0);
    return {base,cpu,hdd,gpu,hba,dc,mainDc,driveDc,mainWall,driveWall,wall,pathological,pathologicalWall,headroom,mainPeak,drivePeak,dual,psuWaste};
  }
  function fitModel(c){
    const issues=[],warnings=[],oks=[]; let level='ok';
    const placement=psuPlacement(c),maxCooler=coolerPlanningLimit(c);
    if(placement==='invalidATXBottom'){issues.push('N6 的下置电源位只支持 SFX；当前选择的 ATX 电源不能下置。');level='bad';}
    if(c.psuPosition==='dual'){
      warnings.push('双电源只是在主机与硬盘背板之间分担负载，不是可无缝切换的冗余热备；模型已把两颗 PSU 的转换损耗分别计算。');level=level==='bad'?'bad':'warn';
      if(c.secondaryPsu.confidence==='unknown'){issues.push('第二颗 SFX 尚未锁定具体型号：外围线束数量、低负载效率与模组针脚未知，当前双电源方案不可直接下单。');level='bad';}
      if(c.dualStart!=='sync'){issues.push('尚未规划 PS_ON 同步启动，第二颗背板电源不能保证随主机自动启停。');level='bad';}
      else {warnings.push('PS_ON 同步模块只按功能占位；购买前仍要核对额定值、接线与掉电故障模式。');level=level==='bad'?'bad':'warn';}
    }
    if(['frontSFX','frontSFX_plus_bottomSFX'].includes(placement)){
      warnings.push(c.frontRequested?'你同时选择了前置 SFX 与完整前部风扇/冷排：手册展示的安装面重叠，但没有共存尺寸；模拟器按保守互斥处理，前部风扇不计入有效风量。':'前置 SFX 占用前部安装区；手册没有给出它与单个前风扇的共存矩阵，若需要完整前进风请改用 SFX 后下置或 ATX 后上置。');
      level=level==='bad'?'bad':'warn';
    }
    if(['bottomSFX','rearUpperATX_plus_bottomSFX','frontSFX_plus_bottomSFX'].includes(placement)&&c.side){warnings.push('下置 SFX 按官方步骤会拆除左侧风扇支架；侧风扇只能按右侧位置规划并实测。');level=level==='bad'?'bad':'warn';}
    if(c.cooler.type==='水冷') { if(c.cooler.fit==='front240'){warnings.push('手册列出前置 240mm 冷排安装位，但没有给冷排总厚度、接头、冷管和 GPU 尾部的共存尺寸；必须按具体冷排与显卡实测。');level=level==='bad'?'bad':'warn';if(['frontSFX','frontSFX_plus_bottomSFX'].includes(placement)){issues.push('前置 SFX 与前置 240 冷排在手册示意中共享前部安装面；在厂商没有给出共存尺寸前，按保守互斥。');level='bad';}} else {if(overheadPsu(c)){issues.push('后上置 ATX 电源占用后部支架，不能同时规划后置 120 冷排。');level='bad';}else{warnings.push('后置 120mm 是风扇位，手册没有明确承诺 120mm 冷排；冷排、冷管与主板的真实干涉需拿到手比对。');level=level==='bad'?'bad':'warn';}} }
    else if(c.cooler.height>maxCooler){issues.push(`${topologyLabel(c)} 的规划散热限高 ${maxCooler}mm，${c.cooler.name} 高 ${c.cooler.height}mm。`);level='bad';}
    else {const gap=maxCooler-c.cooler.height; if(gap<=2){warnings.push(`散热器只剩 ${gap}mm 规划余量，进风与装配公差不足。`);level=level==='bad'?'bad':'warn';} else oks.push(`散热器高度 ${c.cooler.height}mm；按当前拓扑映射的规划包络 ${maxCooler}mm，余 ${gap}mm。`);warnings.push('N6 只发布 65–160mm 散热范围，没有说明两个端点分别对应哪种电源拓扑；当前限高映射属于结构推算。');level=level==='bad'?'bad':'warn';}
    // The "swap the memory later and the cooler comes off again" caveat is no
    // longer typed here: src/core/assembly.ts derives it from the fin overhang.
    if(c.cooler.ram<c.ram.height){issues.push(`${c.cooler.name} 内存限高 ${c.cooler.ram}mm，当前内存约 ${c.ram.height}mm。`);level='bad';}
    if(c.gpu.length>limits.gpuMm.publishedMax){issues.push(`${c.gpu.name} 规划长度 ${c.gpu.length}mm，超过 N6 发布范围的最大端点 ${limits.gpuMm.publishedMax}mm。`);level='bad';}
    else if(c.gpu.length>limits.gpuMm.publishedMin){warnings.push(`${c.gpu.name} 长 ${c.gpu.length}mm，位于 N6 发布的 275–320mm 条件区；厂商未说明端点对应拓扑，必须用具体 SKU 实测前部件与供电插头余量。`);level=level==='bad'?'bad':'warn';}
    else if(c.gpu.tgp){oks.push(`GPU 长 ${c.gpu.length}mm，不超过 N6 发布范围的较小端点 275mm；这仍不等于已验证卡高、供电插头和冷管余量。`);}
    if(c.gpu.tgp&&!c.gpu.specificGeometry){warnings.push('当前消费级 GPU 只是芯片级规划包络，不是具体厂商 SKU；请选择“自定义具体显卡包络”录入实卡尺寸后再做购买判断。');level=level==='bad'?'bad':'warn';}
    if((hasHba(c)||c.preserve) && c.gpu.slots>2){issues.push(`${c.gpu.slots} 槽显卡会遮挡底部 PCIe ×4，无法与${hasHba(c)?'当前必需的':'预留的'} HBA 共存。`);level='bad';}
    if(c.gpu.tgp>=230&&!c.side){warnings.push('230W 以上 GPU 建议增加侧面 2×120mm 风扇。');level=level==='bad'?'bad':'warn';}
    if(!c.drive){warnings.push('当前未勾选盘区 2×120mm 风扇；N6 手册只列安装位，不能假定机箱随附。企业盘投入使用前建议补装并按盘温调速。');level=level==='bad'?'bad':'warn';}
    if(hasHba(c)&&!c.side){warnings.push('LSI 9300-8i 为被动散热 HBA；没有侧向定向气流时芯片可能积热，建议至少一组 120mm 风扇直吹。');level=level==='bad'?'bad':'warn';}
    if(c.boot==='bay'&&c.disks>=limits.trays){issues.push('9 块数据 HDD 已占满全部托架，2.5″ SATA 启动 SSD 无盘位可放。');level='bad';}
    if(c.boot==='m2')warnings.push('TrueNAS 会独占整块 980 PRO，剩余一块无法组成 fast pool 镜像。');
    if(c.boot==='usbssd')warnings.push('外置 USB SSD 可以腾出第 9 盘位，但要固定线材并接受外接链路风险。');
    if(powerModel(c).headroom<.2){issues.push('病态同时峰值下 PSU 余量低于 20%。');level='bad';} else if(powerModel(c).headroom<.35){warnings.push('同时起盘 + CPU/GPU 满载时 PSU 余量低于 35%，应限制功耗或升级电源。');level=level==='bad'?'bad':'warn';}
    const harness=backplaneHarnessCount(c);
    if(c.psuPosition==='dual'&&harness<4){warnings.push(`双电源只计算专供背板的 ${c.secondaryPsu.name}：当前已确认/录入 ${harness} 条独立外围线，少于背板四口，不能把主电源线束相加。需锁定原生提供四路或有同型号授权线的具体 PSU。`);level=level==='bad'?'bad':'warn';}
    else if(harness<4){warnings.push(`按原盒清单保守估计只有 ${harness} 条独立外围线束，少于 N6 背板建议的 4 条。`);level=level==='bad'?'bad':'warn';}
    if(!c.front&&overheadPsu(c)){warnings.push('后上置 ATX + 下压散热器需要前置进风；关闭前风扇会显著抬高 CPU 温度。');level=level==='bad'?'bad':'warn';}
    if(c.rear&&!rearFanAvailable(c)){issues.push('后上 ATX 电源与后置 120mm 风扇位互斥。');level='bad';}
    if(caseFanGroupCount(c)>limits.chassisFanHeaders){warnings.push(`当前有 ${caseFanGroupCount(c)} 组机箱风扇，超过主板 ${limits.chassisFanHeaders} 个 CHA_FAN 口；需要 SATA 供电 PWM 集线器或经核对后复用其他风扇口。`);level=level==='bad'?'bad':'warn';}
    if(['frontSFX','frontSFX_plus_bottomSFX'].includes(placement)&&c.cooler.type==='塔式风冷'&&!c.rear){warnings.push('SFX 前置 + 塔式风冷可规划共存，但建议增加后置 120mm 排风形成稳定气流。');level=level==='bad'?'bad':'warn';}
    if(c.ram.modules===1){warnings.push('当前只装一条内存，系统会以单通道运行；过渡可用，长期建议补同料号组成 A2+B2 双通道。');level=level==='bad'?'bad':'warn';}
    if(c.ram.ecc){warnings.push('ECC 路线要求 DDR5 ECC UDIMM、i5-14500、W680 与 BIOS 同时正确识别；具体料号仍需核 ASUS QVL，RDIMM/LRDIMM 不兼容。');level=level==='bad'?'bad':'warn';}
    if(c.ram.xmp){warnings.push(`${c.ram.mpn||c.ram.name} 为 XMP 超频套条；ASUS QVL ${c.ram.qvl?'有本料号记录':'未确认本料号'}，但 i5-14500 官方 DDR5 基线是 4800，不能保证标称频率。`);level=level==='bad'?'bad':'warn';}
    return {level,issues,warnings,oks,maxCooler};
  }
  function psuWasteHeatW(psu,dc){const eta=Math.max(.5,Math.min(.98,psu.efficiency||.88));return dc<=0?0:dc*(1/eta-1);}
  function psuNoiseDb(psu,dc){
    if(psu.fanOff>0&&dc<psu.fanOff)return 0;
    if(psu.fanOff<=0&&!(psu.noiseDba>0))return 0;
    return psu.noiseDba||24;
  }
  /**
   * Sound only. Every temperature in the UI now comes from the V2 air-balance model
   * (`LAB.evaluate().thermal`), which reports ranges with its assumptions attached;
   * the single-point ΔT tables that used to live here could not be reconciled with
   * it and are gone.
   */
  function acousticModel(c,p){
    const activeHddNoise=(c.workload==='idle'?28:32)+10*Math.log10(c.disks);
    const loadRatio=Math.min(1,p.cpu/Math.max(1,c.pl1));
    const coolerNoise=c.cooler.idleNoise+(c.cooler.maxNoise-c.cooler.idleNoise)*loadRatio+({quiet:-2,balanced:0,performance:2}[c.fan]);
    const gpuNoise=p.gpu>c.gpu.idle+5?c.gpu.noise:(c.gpu.tgp?18:0);
    const fanSource={quiet:17,balanced:20,performance:25}[c.fan],caseSources=[];
    if(c.front)caseSources.push(fanSource+3);if(c.rear)caseSources.push(fanSource);if(c.drive)caseSources.push(fanSource+3);if(c.side)caseSources.push(fanSource+3);
    const caseNoise=logSum(caseSources),mainPsuNoise=psuNoiseDb(c.psu,p.mainDc),drivePsuNoise=p.dual?psuNoiseDb(c.secondaryPsu,p.driveDc):0,psuNoise=logSum([mainPsuNoise,drivePsuNoise].filter(v=>v>0));
    const noise=Math.round(logSum([activeHddNoise,coolerNoise,gpuNoise,caseNoise,psuNoise].filter(v=>v>0)));
    return {noise,parts:{'硬盘':activeHddNoise,'CPU 风扇':coolerNoise,'GPU':gpuNoise,'机箱风扇':caseNoise,'PSU':psuNoise}};
  }
  function gpuVerdict(g,c){
    if(!g.tgp)return {level:'ok',text:'暂不安装',reason:'不占 PCIe 与散热空间'};
    if(g.length>limits.gpuMm.publishedMax)return {level:'bad',text:'超出发布范围',reason:`卡长 ${g.length}mm > 320mm 最大端点`};
    if((hasHba(c)||c.preserve)&&g.slots>2)return {level:'bad',text:'不兼容 HBA',reason:'超过 2 槽会挡 PCIe ×4'};
    if(g.tgp>=300)return {level:'bad',text:'热密度过高',reason:'N6 不适合 300W+ 消费卡'};
    if(!g.specificGeometry)return {level:'warn',text:'仅供规划',reason:'不是具体 SKU；需录入实卡长/厚/TGP'};
    if(g.length>limits.gpuMm.publishedMin)return {level:'warn',text:'条件区',reason:'位于 275–320mm 发布范围，端点与拓扑关系未知'};
    if(g.tgp>=200)return {level:'warn',text:'有条件',reason:'需侧风扇、功耗限制与实卡尺寸复核'};
    return {level:'ok',text:'包络可规划',reason:g.kind==='工作站'?'参考卡较窄、低功耗，可保留扩展':'已录入具体包络；仍需实物核对插头/线材'};
  }
  function accessoryActive(c,key){
    if(key==='slim')return sataDeviceCount(c)>4&&!hasHba(c);
    if(key==='hba')return hasHba(c);
    if(key==='boot')return c.boot==='bay';
    if(key==='usbboot')return c.boot==='usbssd';
    if(key==='front')return c.front&&c.cooler.fit!=='front240';
    if(key==='rearfan')return c.rear&&c.coolerKey!=='cooler.aio-120-experimental';
    if(key==='sidefans')return c.side;
    if(key==='drivefans')return c.drive;
    if(key==='dualsfx'||key==='dualcables'||key==='dualsync')return c.psuPosition==='dual';
    // Only offer extra leads when the PSU still has a free SATA/PATA socket to plug one into.
    if(key==='psucable')return c.psuPosition!=='dual'&&c.psu.harness<4&&(c.psu.peripheralSockets===0||c.psu.peripheralSockets>=4);
    return state.selectedAccessories.has(key);
  }
  function priceModel(c,includeGpu=false,diskCount=c.disks){
    let total=c.psu.mid+c.cooler.mid+c.ram.mid+4500*diskCount;
    Object.keys(accessories).forEach(k=>{if(accessoryActive(c,k))total+=k==='dualsfx'?c.secondaryPsu.mid:accessories[k].mid;});
    if(includeGpu)total+=c.gpu.mid;
    return total;
  }

  const thermalStops=[[20,[30,64,175]],[35,[0,174,239]],[45,[34,197,94]],[60,[250,204,21]],[75,[249,115,22]],[90,[239,68,68]],[100,[127,29,29]]];
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  function thermalRgb(value){
    const t=clamp(value,20,100);let j=1;while(j<thermalStops.length&&t>thermalStops[j][0])j++;
    const [a,ca]=thermalStops[j-1],[b,cb]=thermalStops[Math.min(j,thermalStops.length-1)],u=b===a?0:(t-a)/(b-a);
    return ca.map((v,k)=>Math.round(v+(cb[k]-v)*u));
  }
  function thermalCss(value){const [r,g,b]=thermalRgb(value);return `rgb(${r} ${g} ${b})`;}
  // Interval width gets its own ramp: it is a K spread, not a temperature, so
  // reusing the 20–100°C engineering scale for it would misread as "cool".
  const widthStops=[[0,[30,64,175]],[6,[0,174,239]],[12,[34,197,94]],[20,[250,204,21]],[30,[249,115,22]],[45,[239,68,68]]];
  function rampRgb(stops,value,lo,hi){
    const t=clamp(value,lo,hi);let j=1;while(j<stops.length&&t>stops[j][0])j++;
    const [a,ca]=stops[j-1],[b,cb]=stops[Math.min(j,stops.length-1)],u=b===a?0:(t-a)/(b-a);
    return ca.map((v,k)=>Math.round(v+(cb[k]-v)*u));
  }
  const WIDTH_MAX_K=45;
  const evidenceZh={official:'官方',standard:'标准',inferred:'推算',unknown:'未知'};

  /** Which end of every range the thermal views colour by, and the slice plane. */
  const heatState={bound:'hi',plane:'xy'};
  // Last evaluation, so switching bound or plane redraws the field without re-running
  // the whole page.
  let lastEval=null,lastConfig=null;
  const heatBoundLabel={hi:'保守（区间上限）',lo:'乐观（区间下限）',width:'区间宽度 hi−lo'};
  function thermalNode(ev,id){
    const nodes=ev&&ev.thermal?ev.thermal.components:null;
    return nodes?nodes.find(n=>n.id===id)||null:null;
  }
  function nodeTemp(ev,id){const n=thermalNode(ev,id);return n?n.tempC:null;}
  const rangeC=r=>!r?'—':Math.abs(r.hi-r.lo)<.5?`${Math.round(r.lo)}°C`:`${Math.round(r.lo)}–${Math.round(r.hi)}°C`;
  /** Colour a node by the selected bound; `width` still needs a temperature. */
  const boundTemp=r=>!r?null:heatState.bound==='lo'?r.lo:r.hi;

  /**
   * Orthographic slice planes. `u` runs right on screen, `v` runs up unless the
   * plane's vertical axis is depth, where front-at-top reads more naturally.
   */
  const heatPlanes={
    xy:{id:'xy',label:'前视 x–y',axes:['x','y'],fixed:'z',vUp:true,note:'前视：宽×高，沿深度方向取切片'},
    yz:{id:'yz',label:'侧视 z–y',axes:['z','y'],fixed:'x',vUp:true,note:'侧视：深×高，隔板与前后风路都在面内'},
    xz:{id:'xz',label:'俯视 x–z',axes:['x','z'],fixed:'y',vUp:false,note:'俯视：宽×深，切片高度决定看到的是哪个腔体'}
  };
  const AXIS_INDEX={x:0,y:1,z:2};
  const AXIS_SIZE={x:'w',y:'h',z:'d'};
  function interiorSpan(axis){
    const b=CASE_GEO.interior,i=AXIS_INDEX[axis],half=(axis==='x'?b.w:axis==='y'?b.h:b.d)/2;
    return [b.c[i]-half,b.c[i]+half];
  }
  /** Slice offset per plane: the depth/width mid-plane, or just above the deck. */
  function sliceOffset(plane){
    if(plane.fixed==='y')return CASE_GEO.deckY+40;
    return 0;
  }
  // Plot box inside the canvas: left gutter for the mm ruler, right column for the
  // heat-source legend, bottom strip for the mm ruler.
  const FIELD={w:720,h:420,left:46,top:16,plotW:452,plotH:370,legendX:518};
  function fieldTransform(plane){
    const [uMin,uMax]=interiorSpan(plane.axes[0]),[vMin,vMax]=interiorSpan(plane.axes[1]);
    const scale=Math.min(FIELD.plotW/(uMax-uMin),FIELD.plotH/(vMax-vMin));
    const wPx=(uMax-uMin)*scale,hPx=(vMax-vMin)*scale;
    const x0=FIELD.left+(FIELD.plotW-wPx)/2,y0=FIELD.top+(FIELD.plotH-hPx)/2;
    return {
      uMin,uMax,vMin,vMax,scale,wPx,hPx,x0,y0,
      px:u=>x0+(u-uMin)*scale,
      py:v=>plane.vUp?y0+hPx-(v-vMin)*scale:y0+(v-vMin)*scale
    };
  }
  function partSpan(part,axis){
    const i=AXIS_INDEX[axis],half=part.box[AXIS_SIZE[axis]]/2;
    return [part.box.c[i]-half,part.box.c[i]+half];
  }
  /** Screen rect of a part's projection onto the current plane. */
  function partRect(part,plane,tf){
    const [uLo,uHi]=partSpan(part,plane.axes[0]),[vLo,vHi]=partSpan(part,plane.axes[1]);
    const x=tf.px(uLo),y=plane.vUp?tf.py(vHi):tf.py(vLo);
    return {x,y,w:Math.max(1,(uHi-uLo)*tf.scale),h:Math.max(1,(vHi-vLo)*tf.scale)};
  }
  const OUTLINE_SKIP=new Set(['clearance']);
  const OUTLINE_STYLE={
    conflict:{stroke:'#ef4444',width:1.8,dash:[4,2]},
    drive:{stroke:'#fff',width:1.3},
    cooler:{stroke:'#fff',width:1.4},
    gpu:{stroke:'#fff',width:1.4},
    hba:{stroke:'#fff',width:1.2},
    psu:{stroke:'#fff',width:1.3},
    fan:{stroke:'rgba(219,246,255,.9)',width:1.2,dash:[5,4]}
  };
  function renderThermalField(c,ev){
    const canvas=$('#thermal-field'),ctx=canvas.getContext('2d'),plane=heatPlanes[heatState.plane];
    const flow=$('#thermal-flow-paths'),labels=$('#thermal-field-labels'),field=ev&&ev.heatField;
    ctx.clearRect(0,0,FIELD.w,FIELD.h);
    if(!field||field.sources.length===0){
      flow.innerHTML='';
      labels.innerHTML='<text class="thermal-field-note" x="46" y="40">当前配置没有热源可画（引擎未返回热源）。</text>';
      $('#thermal-field-badge').textContent='无热源 · 引擎未返回温度场';
      return;
    }
    const tf=fieldTransform(plane),grid=3;
    const slice=LAB.thermalSlice(field,plane.id,sliceOffset(plane),[tf.uMin,tf.uMax,tf.vMin,tf.vMax],grid);
    const cell=grid*tf.scale;
    for(let r=0;r<slice.rows;r++){
      for(let col=0;col<slice.cols;col++){
        const i=r*slice.cols+col,lo=slice.lo[i],hi=slice.hi[i];
        const rgb=heatState.bound==='width'
          ? rampRgb(widthStops,hi-lo,0,WIDTH_MAX_K)
          : thermalRgb(heatState.bound==='lo'?lo:hi);
        const u=tf.uMin+col*grid,v=tf.vMin+r*grid;
        ctx.fillStyle=`rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
        ctx.fillRect(tf.px(u),plane.vUp?tf.py(v)-cell:tf.py(v),cell+.6,cell+.6);
      }
    }

    // Structure: the same PlacedPart boxes the isometric view draws, projected onto
    // this plane. Parts the slice actually cuts through are drawn solid; parts in
    // front of or behind it are faint, so "outline over colour" cannot mislead.
    const offset=sliceOffset(plane);
    ctx.save();ctx.beginPath();ctx.rect(tf.x0,tf.y0,tf.wPx,tf.hPx);ctx.clip();
    for(const part of ev.geometry){
      if(OUTLINE_SKIP.has(part.kind))continue;
      const style=OUTLINE_STYLE[part.kind]||{stroke:'rgba(255,255,255,.72)',width:1};
      const [fLo,fHi]=partSpan(part,plane.fixed),cut=offset>=fLo&&offset<=fHi;
      const rect=partRect(part,plane,tf);
      ctx.globalAlpha=cut?.8:.26;
      ctx.strokeStyle=style.stroke;ctx.lineWidth=style.width;
      ctx.setLineDash(style.dash||[]);
      ctx.strokeRect(rect.x,rect.y,rect.w,rect.h);
    }
    ctx.setLineDash([]);
    // The deck is the barrier the field obeys; draw it as such where it is in-plane.
    if(plane.axes[1]==='y'){
      const y=tf.py(field.barrierY);
      ctx.globalAlpha=.9;ctx.strokeStyle='#fff';ctx.lineWidth=1.6;ctx.setLineDash([10,4]);
      ctx.beginPath();ctx.moveTo(tf.x0,y);ctx.lineTo(tf.x0+tf.wPx,y);ctx.stroke();ctx.setLineDash([]);
    }
    ctx.restore();
    ctx.globalAlpha=.6;ctx.strokeStyle='#fff';ctx.lineWidth=1.2;ctx.strokeRect(tf.x0,tf.y0,tf.wPx,tf.hPx);
    ctx.globalAlpha=1;

    flow.innerHTML=airflowMarkers(ev,plane,tf,c).join('');
    labels.innerHTML=[
      ...millimetreRuler(plane,tf),
      ...heatSourceMarkers(field,plane,tf),
      ...heatSourceLegend(field),
      `<text class="thermal-field-note" x="${FIELD.left}" y="${FIELD.h-6}">${plane.note} · 切片 ${plane.fixed} = ${Math.round(offset)}mm · 格 ${grid}mm · ${heatBoundLabel[heatState.bound]}</text>`
    ].join('');

    const peak=heatState.bound==='width'
      ? `区间最宽 ${Math.round(sliceSpread(slice))}K`
      : `切片峰值 ${Math.round(heatState.bound==='lo'?slice.minC:slice.maxC)}°C`;
    const hottest=field.sources.reduce((a,s)=>s.tempC.hi>a.tempC.hi?s:a,field.sources[0]);
    $('#thermal-field-badge').textContent=`${plane.label} · ${peak} · 最热源 ${hottest.label} ${rangeC(hottest.tempC)} · 非 CFD / 非实测`;
    canvas.setAttribute('aria-label',`${plane.label} 正交切片温度场，按${heatBoundLabel[heatState.bound]}着色；最热源 ${hottest.label} ${rangeC(hottest.tempC)}；由 0D 换热模型插值，非 CFD、非实测`);
    $('#thermal-ambient-marker').style.left=`calc(${clamp((field.ambientC-20)/80*100,0,100)}% - 1px)`;
    $('#thermal-field-scale-note').textContent=heatState.bound==='width'
      ? `色标改为区间宽度 0–${WIDTH_MAX_K}K：颜色越暖表示该点的上下限差得越远，即模型对它越没把握。`
      : '色标为固定 20–100°C 工程温标。上限不是预测值，而是"这个状态不可接受"的判据；下限是"一切顺利"的下界，真值在两者之间。';
  }
  function sliceSpread(slice){
    let max=0;
    for(let i=0;i<slice.lo.length;i++)max=Math.max(max,slice.hi[i]-slice.lo[i]);
    return max;
  }
  function millimetreRuler(plane,tf){
    const out=[],step=50;
    const first=u=>Math.ceil(u/step)*step;
    for(let u=first(tf.uMin);u<=tf.uMax;u+=step){
      const x=tf.px(u).toFixed(1);
      out.push(`<line class="thermal-tick" x1="${x}" y1="${(tf.y0+tf.hPx).toFixed(1)}" x2="${x}" y2="${(tf.y0+tf.hPx+5).toFixed(1)}"></line>`);
      out.push(`<text class="thermal-tick-label" x="${x}" y="${(tf.y0+tf.hPx+16).toFixed(1)}" text-anchor="middle">${u}</text>`);
    }
    for(let v=first(tf.vMin);v<=tf.vMax;v+=step){
      const y=tf.py(v).toFixed(1);
      out.push(`<line class="thermal-tick" x1="${(tf.x0-5).toFixed(1)}" y1="${y}" x2="${tf.x0.toFixed(1)}" y2="${y}"></line>`);
      out.push(`<text class="thermal-tick-label" x="${(tf.x0-8).toFixed(1)}" y="${(+y+3).toFixed(1)}" text-anchor="end">${v}</text>`);
    }
    const barMm=50,barPx=barMm*tf.scale;
    out.push(`<line class="thermal-scalebar" x1="${tf.x0.toFixed(1)}" y1="${(tf.y0-6).toFixed(1)}" x2="${(tf.x0+barPx).toFixed(1)}" y2="${(tf.y0-6).toFixed(1)}"></line>`);
    out.push(`<text class="thermal-tick-label" x="${(tf.x0+barPx+6).toFixed(1)}" y="${(tf.y0-3).toFixed(1)}">${barMm}mm（${plane.axes[0]}/${plane.axes[1]} 轴，mm）</text>`);
    return out;
  }
  function heatSourceMarkers(field,plane,tf){
    return field.sources.map(s=>{
      const u=s.at[AXIS_INDEX[plane.axes[0]]],v=s.at[AXIS_INDEX[plane.axes[1]]];
      const temp=boundTemp(s.tempC);
      return `<circle class="thermal-source" data-evidence="${s.evidence}" cx="${tf.px(u).toFixed(1)}" cy="${tf.py(v).toFixed(1)}" r="3.4" fill="${thermalCss(temp)}"><title>${s.label} · ${rangeC(s.tempC)} · ${s.watts.toFixed(1)}W · θ 证据 ${evidenceZh[s.evidence]||s.evidence}</title></circle>`;
    });
  }
  function heatSourceLegend(field){
    const out=[`<text class="thermal-field-note" x="${FIELD.legendX}" y="${FIELD.top+8}">热源（质心取自几何真源）</text>`];
    const byNode=new Map();
    for(const s of field.sources){
      const row=byNode.get(s.nodeId);
      if(row){row.count++;row.watts+=s.watts;}
      else byNode.set(s.nodeId,{label:s.label,temp:s.tempC,watts:s.watts,evidence:s.evidence,count:1,chamber:s.chamber});
    }
    // The legend column is 200px wide, so a long SKU name gets its parenthetical
    // clipped rather than running off the canvas.
    const shorten=s=>s.replace(/（([^）]*)）/,(m,inner)=>`（${inner.length>12?inner.slice(0,11)+'…':inner}）`);
    let y=FIELD.top+26;
    for(const row of byNode.values()){
      const name=row.count>1
        ? `${row.label.split(' · ')[0].replace(/（[^）]*）/,'')} ×${row.count}`
        : shorten(row.label);
      out.push(`<circle class="thermal-source" data-evidence="${row.evidence}" cx="${FIELD.legendX+4}" cy="${y-4}" r="4" fill="${thermalCss(boundTemp(row.temp))}"></circle>`);
      out.push(`<text class="thermal-field-label" x="${FIELD.legendX+15}" y="${y}">${name}</text>`);
      out.push(`<text class="thermal-field-note" x="${FIELD.legendX+15}" y="${y+13}">${rangeC(row.temp)} · ${row.watts.toFixed(1)}W · ${row.chamber==='lower'?'下层':'上层'} · θ ${evidenceZh[row.evidence]||row.evidence}</text>`);
      y+=34;
    }
    out.push(`<text class="thermal-field-note" x="${FIELD.legendX}" y="${y+4}">隔板跨腔传热系数 ${field.barrierLeak===0?'0（两腔互不影响）':field.barrierLeak}</text>`);
    return out;
  }
  /**
   * Arrows come from the fan parts the geometry model placed: a fan's thinnest axis
   * is its flow axis. When that axis is perpendicular to the slice, an arrow would
   * be a lie, so the fan is marked with a through-plane glyph instead.
   */
  function airflowMarkers(ev,plane,tf,c){
    const intensity={quiet:.65,balanced:1,performance:1.25}[c.fan],out=[];
    const seen=new Set();
    for(const part of ev.geometry){
      if(part.kind!=='fan')continue;
      const dims=[['x',part.box.w],['y',part.box.h],['z',part.box.d]].sort((a,b)=>a[1]-b[1]);
      const axis=dims[0][0],key=`${part.name}:${axis}`;
      const u=part.box.c[AXIS_INDEX[plane.axes[0]]],v=part.box.c[AXIS_INDEX[plane.axes[1]]];
      const x=tf.px(u),y=tf.py(v);
      if(axis===plane.fixed){
        if(seen.has(key))continue;
        seen.add(key);
        out.push(`<circle class="thermal-flow-through" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9"></circle><circle class="thermal-flow-through-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2"></circle>`);
        continue;
      }
      // Flow runs from the fan toward the far side of the case along its own axis.
      const [lo,hi]=interiorSpan(axis),toward=Math.abs(hi-part.box.c[AXIS_INDEX[axis]])>Math.abs(part.box.c[AXIS_INDEX[axis]]-lo)?hi:lo;
      const len=Math.min(120,Math.abs(toward-part.box.c[AXIS_INDEX[axis]])*tf.scale*.6);
      const horizontal=axis===plane.axes[0];
      const sign=(toward>part.box.c[AXIS_INDEX[axis]]?1:-1)*(horizontal||plane.vUp===false?1:-1);
      const x2=horizontal?x+sign*len:x,y2=horizontal?y:y+sign*len;
      out.push(`<path class="thermal-flow" d="M${x.toFixed(1)} ${y.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}" style="stroke-width:${(1.5+2*Math.min(1,intensity)).toFixed(1)}px;animation-duration:${(1.9-.7*Math.min(1,intensity)).toFixed(2)}s"></path>`);
    }
    return out;
  }
  function updateTopThermalMap(c,p,ev){
    const ambient=ev.thermal?ev.thermal.ambientC:c.ambient;
    const cpuT=nodeTemp(ev,'cpu'),hddT=nodeTemp(ev,'hdd'),gpuT=nodeTemp(ev,'gpu');
    // The overview glow is a comparison aid, so it always shows the conservative end.
    const setStop=(id,temp,opacity)=>{const el=$(id);if(!el||temp===null)return;el.setAttribute('stop-color',thermalCss(temp));if(opacity!==undefined)el.setAttribute('stop-opacity',opacity);};
    const hi=r=>r?r.hi:null;
    setStop('#cpu-heat-core',hi(cpuT),.95);setStop('#cpu-heat-mid',cpuT?(cpuT.hi+ambient)/2:null,.58);
    setStop('#drive-heat-core',hi(hddT),.78);setStop('#drive-heat-mid',hddT?(hddT.hi+ambient)/2:null,.42);
    setStop('#gpu-heat-core',hi(gpuT),.92);setStop('#gpu-heat-mid',gpuT?(gpuT.hi+ambient)/2:null,.54);
    const cpu=$('#cpu-glow'),gpu=$('#gpu-glow'),drives=$('#drive-glow'),hba=$('#hba-glow'),plume=$('#thermal-plume'),gpuWidth=Math.min(430,Math.max(120,c.gpu.length/275*390));
    cpu.setAttribute('r',Math.round(54+Math.sqrt(Math.max(0,p.cpu))*2.2));cpu.setAttribute('opacity',clamp(.30+p.cpu/220,.3,.92));gpu.setAttribute('cx',185+gpuWidth/2);gpu.setAttribute('rx',gpuWidth/2+28);gpu.setAttribute('opacity',gpuT?clamp(.25+p.gpu/430,.25,.9):0);drives.setAttribute('x',65);drives.setAttribute('width',52+(c.disks-1)*65);drives.setAttribute('opacity',clamp(.34+c.disks*.045,.34,.82));hba.classList.toggle('is-hidden',!p.hba);hba.setAttribute('opacity',p.hba ? .58 : 0);plume.setAttribute('opacity',clamp((p.cpu+p.gpu+p.hdd)/520,.12,.48));
    $('#thermal-scale-low').textContent=`${ambient}°C 环境`;$('#thermal-scale-high').textContent='100°C 固定上限';
    $('#thermal-map-summary').textContent=`按区间上限着色 · CPU ${rangeC(cpuT)} · HDD ${rangeC(hddT)}${gpuT?' · GPU '+rangeC(gpuT):''} · 非 CFD`;
  }

  const spatialNS = 'http://www.w3.org/2000/svg';
  const spatialState = {yaw:-.72,pitch:-.46,zoom:.93,dragging:false,x:0,y:0,config:null,parts:[],routing:null,showRoutes:false,routeFocus:null};
  function spatialEl(tag,attrs={},label=''){
    const el=document.createElementNS(spatialNS,tag);
    Object.entries(attrs).forEach(([key,value])=>el.setAttribute(key,value));
    if(label)el.textContent=label;
    return el;
  }
  function spatialRotated(point){
    const [x,y,z]=point,cy=Math.cos(spatialState.yaw),sy=Math.sin(spatialState.yaw),cp=Math.cos(spatialState.pitch),sp=Math.sin(spatialState.pitch);
    const x1=x*cy+z*sy,z1=-x*sy+z*cy;
    return {x:x1,y:y*cp-z1*sp,z:y*sp+z1*cp};
  }
  function spatialProject(point){
    const q=spatialRotated(point),perspective=900/(900-q.z),scale=1.04*spatialState.zoom*perspective;
    return {x:380+q.x*scale,y:326-q.y*scale,z:q.z};
  }
  function spatialVertices(box){
    const x=box.c[0],y=box.c[1],z=box.c[2],a=box.w/2,b=box.h/2,d=box.d/2;
    return [[x-a,y-b,z-d],[x+a,y-b,z-d],[x+a,y+b,z-d],[x-a,y+b,z-d],[x-a,y-b,z+d],[x+a,y-b,z+d],[x+a,y+b,z+d],[x-a,y+b,z+d]];
  }
  function spatialEdge(layer,a,b,className='spatial-wire'){
    const p=spatialProject(a),q=spatialProject(b);
    layer.appendChild(spatialEl('line',{x1:p.x.toFixed(2),y1:p.y.toFixed(2),x2:q.x.toFixed(2),y2:q.y.toFixed(2),class:className}));
  }
  function spatialDimension(layer,a,b,label,source,dx=0,dy=0){
    const p=spatialProject(a),q=spatialProject(b),mx=(p.x+q.x)/2+dx,my=(p.y+q.y)/2+dy;
    layer.appendChild(spatialEl('line',{x1:p.x.toFixed(2),y1:p.y.toFixed(2),x2:q.x.toFixed(2),y2:q.y.toFixed(2),class:`spatial-dimension ${source}`}));
    const text=spatialEl('text',{x:mx.toFixed(2),y:my.toFixed(2),'text-anchor':'middle',class:`spatial-dim-label ${source}`},label);
    layer.appendChild(text);
  }
  function spatialCallout(layer,anchor,label,dx,dy){
    const p=spatialProject(anchor),x=p.x+dx,y=p.y+dy,anchorSide=dx<0?'end':'start';
    layer.appendChild(spatialEl('line',{x1:p.x.toFixed(2),y1:p.y.toFixed(2),x2:x.toFixed(2),y2:(y-4).toFixed(2),class:'spatial-part-callout'}));
    layer.appendChild(spatialEl('text',{x:(x+(dx<0?-5:5)).toFixed(2),y:y.toFixed(2),'text-anchor':anchorSide,class:'spatial-part-label'},label));
  }
  function spatialBoxLabel(box){ return `${box.name} · ${box.dims}`; }
  /**
   * Callout layout. The text comes from the part itself; only the leader-line
   * offsets live here, because those are drawing decisions and not geometry.
   */
  const spatialCallouts=[
    {id:'board',dx:52,dy:18,text:()=>'mATX 244×244mm'},
    {id:'ram.last',dx:56,dy:-9,text:(b,c)=>`${c.ram.name} · 已装 ${ramModuleCount(c)} 条`},
    {id:'m2.1',dx:-70,dy:22,text:(b,c)=>c.boot==='m2'?'980 PRO ×2 · 1 启动 + 1 待用':'980 PRO ×2 · ZFS 镜像'},
    {id:'psu.primary',dx:-80,dy:-16},
    {id:'psu.secondary',dx:-64,dy:34},
    {id:'cooler.column',dx:56,dy:-18},
    {id:'cooler.pump',dx:50,dy:-14},
    {id:'cooler.radiator',dx:-70,dy:30},
    {id:'gpu',dx:-62,dy:-22},
    {id:'hba',dx:58,dy:28},
    {id:'hba.reserve',dx:58,dy:28},
    {id:'tray.frame',dx:-22,dy:24,text:(b,c)=>c.boot==='bay'?`9 个托架 · ${c.disks} HDD + 1 Boot SSD`:`9 个竖盘托架横向单排 · 已装 ${c.disks} HDD`},
    {id:'tray.9.boot',dx:58,dy:28,text:()=>'2.5″ SATA Boot · 第 9 托架'},
    {id:'backplane.inlet.3',dx:60,dy:30,text:()=>'硬盘背板 · 四路供电口 SATA×2 + PATA×2'},
    {id:'boot.usb_external',dx:48,dy:24},
    {id:'chassis.psu_rack_plate',dx:42,dy:32,text:()=>'电源架取代左侧风扇架 · 手册 §8.1–8.3'},
    {id:'fan.left_bracket',dx:44,dy:-16,text:()=>'左侧风扇架 · 接背板供电需先拆（§13.1）'},
    {id:'psu.bottom_reserve',dx:-4,dy:62,text:()=>'空置：下置 SFX 电源位'}
  ];
  /**
   * Field mapping only: `PlacedPart` → the render box this view already spoke. The
   * millimetre constants that used to live here now come from geometry.json via
   * `LAB.evaluate`, so the preview, the collision engine and the heat field cannot
   * disagree about where anything is.
   */
  function spatialModel(c,parts){
    const boxes=parts.map(part=>({
      id:part.id,
      name:part.name,
      dims:part.dimsLabel,
      kind:part.kind,
      // A published size anchored by guesswork is still a guess about position.
      source:part.anchorEvidence==='inferred'?'inferred':part.sizeEvidence,
      c:part.box.c,w:part.box.w,h:part.box.h,d:part.box.d
    }));
    const byId=new Map(boxes.map(b=>[b.id,b]));
    const board=byId.get('board');
    const labels=[];
    const push=(box,dx,dy,text)=>labels.push({anchor:[box.c[0],box.c[1]+box.h/2,box.c[2]],text,dx,dy});
    for(const item of spatialCallouts){
      const box=item.id==='ram.last'
        ? [...byId.keys()].filter(k=>k.startsWith('ram.')).map(k=>byId.get(k)).pop()
        : byId.get(item.id);
      if(!box)continue;
      push(box,item.dx,item.dy,item.text?item.text(box,c):spatialBoxLabel(box));
    }
    for(const box of boxes){
      if(box.kind!=='conflict')continue;
      push(box,76,-34,`冲突：${box.name} · ${box.dims}`);
    }
    return {boxes,labels,boardTop:board?board.c[1]+board.h/2:0};
  }
  /**
   * Route drawing. Every millimetre here comes from `ev.routing`, so a polyline in
   * the preview and a row in the routing table are the same solved path; the view
   * adds nothing but the projection.
   */
  function routeState(cable){
    if(!cable.route)return 'none';
    if(cable.segmentHits.length||cable.insertion.some(i=>i.blocks.length))return 'warn';
    if(cable.availableLengthMm!=null&&cable.requiredMm!=null&&cable.availableLengthMm<cable.requiredMm)return 'warn';
    return 'ok';
  }
  function spatialBoxEdges(layer,box,className){
    const v=spatialVertices(box);
    [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]].forEach(([a,b])=>spatialEdge(layer,v[a],v[b],className));
  }
  function drawRoutes(layer){
    const routing=spatialState.routing;
    if(!routing||!routing.cables)return;
    const focus=spatialState.routeFocus;
    for(const cable of routing.cables){
      const dim=focus&&focus!==cable.id?'true':'false',state=routeState(cable);
      const group=spatialEl('g',{class:'spatial-route-group','data-dim':dim});
      const lengths=cable.route?`${Math.round(cable.route.lengthMm)}mm 折线 · 需 ${cable.requiredMm}mm`:'无连通路径';
      group.appendChild(spatialEl('title',{},`${cable.label} · ${lengths}`));
      const pts=cable.route?cable.route.polyline:[];
      for(let i=1;i<pts.length;i++){
        const p=spatialProject(pts[i-1]),q=spatialProject(pts[i]);
        group.appendChild(spatialEl('line',{x1:p.x.toFixed(2),y1:p.y.toFixed(2),x2:q.x.toFixed(2),y2:q.y.toFixed(2),class:'spatial-route','data-kind':cable.kind,'data-state':state}));
      }
      // Interior vertices are the declared openings the cable passes through.
      for(let i=1;i<pts.length-1;i++){
        const p=spatialProject(pts[i]);
        group.appendChild(spatialEl('circle',{cx:p.x.toFixed(2),cy:p.y.toFixed(2),r:2.4,class:'spatial-route-node'}));
      }
      // Only sweeps that something sits inside are drawn: an empty sweep is not news.
      for(const ins of cable.insertion){
        if(!ins.blocks.length)continue;
        spatialBoxEdges(group,ins.sweep,'spatial-route-sweep');
      }
      layer.appendChild(group);
    }
  }
  function renderSpatial(c,parts,routing){
    spatialState.config=c;
    if(parts)spatialState.parts=parts;
    if(routing)spatialState.routing=routing;
    const model=spatialModel(c,spatialState.parts||[]);
    const scene=$('#spatial-scene'),overlay=$('#spatial-screen-overlay');scene.textContent='';overlay.textContent='';
    const faceLayer=spatialEl('g'),lineLayer=spatialEl('g'),dimLayer=spatialEl('g'),labelLayer=spatialEl('g');
    scene.append(faceLayer,lineLayer,dimLayer,labelLayer);
    const env=CASE_GEO.envelope,halfW=env.w/2,halfH=env.h/2,halfD=env.d/2;
    const caseBox={c:[0,0,0],w:env.w,h:env.h,d:env.d,kind:'case-face'},allBoxes=[caseBox,...model.boxes],faces=[];
    const faceIndexes=[[0,1,2,3],[4,7,6,5],[0,4,5,1],[3,2,6,7],[0,3,7,4],[1,5,6,2]];
    allBoxes.forEach((box,index)=>{
      const vertices=spatialVertices(box);
      faceIndexes.forEach(ids=>{
        const projected=ids.map(id=>spatialProject(vertices[id]));
        faces.push({depth:projected.reduce((sum,p)=>sum+p.z,0)/4,points:projected,box,index});
      });
    });
    faces.sort((a,b)=>a.depth-b.depth).forEach(face=>{
      const points=face.points.map(p=>`${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '),kind=face.box.kind;
      faceLayer.appendChild(spatialEl('polygon',{points,class:`spatial-face spatial-${kind}`,'data-source':face.box.source||'official'}));
    });

    const outer=spatialVertices(caseBox),edgeIndexes=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    edgeIndexes.forEach(([a,b])=>spatialEdge(lineLayer,outer[a],outer[b],'spatial-outline'));
    const deckY=CASE_GEO.deckY;
    spatialEdge(lineLayer,[-halfW,deckY,-halfD],[halfW,deckY,-halfD],'spatial-wire inferred');
    spatialEdge(lineLayer,[-halfW,deckY,halfD],[halfW,deckY,halfD],'spatial-wire inferred');

    spatialDimension(dimLayer,[-halfW,halfH+25,-halfD],[halfW,halfH+25,-halfD],`${env.w}mm 宽 · 官方`,'official',0,-8);
    spatialDimension(dimLayer,[halfW+25,halfH+25,-halfD],[halfW+25,halfH+25,halfD],`${env.d}mm 深 · 官方`,'official',0,-8);
    spatialDimension(dimLayer,[-halfW-26,-halfH,-halfD],[-halfW-26,halfH,-halfD],`${env.h}mm 高 · 官方`,'official',-5,0);
    const board=model.boxes.find(b=>b.id==='board');
    if(board){
      const bw=board.w/2,bd=board.d/2,by=board.c[1]+5;
      spatialDimension(dimLayer,[board.c[0]-bw,by,board.c[2]-bd-20],[board.c[0]+bw,by,board.c[2]-bd-20],`${board.w}mm · mATX 标准`,'standard',0,14);
      spatialDimension(dimLayer,[board.c[0]+bw+5,by,board.c[2]-bd],[board.c[0]+bw+5,by,board.c[2]+bd],`${board.d}mm · mATX 标准`,'standard',0,14);
    }
    if(c.cooler.type!=='水冷'){
      const limit=coolerPlanningLimit(c),gap=limit-c.cooler.height,x=101,z=20;
      spatialDimension(dimLayer,[x,model.boardTop,z],[x,model.boardTop+c.cooler.height,z],`${c.cooler.height}mm 散热器 · 厂商规格`,'standard',18,0);
      if(gap>=0)spatialDimension(dimLayer,[x+13,model.boardTop+c.cooler.height,z],[x+13,model.boardTop+limit,z],`余 ${gap}mm · 推算`,'inferred',22,0);
    }
    const gpuBox=model.boxes.find(b=>b.id==='gpu');
    if(gpuBox){
      const x=gpuBox.c[0]-36,y=model.boardTop+10,z0=gpuBox.c[2]-gpuBox.d/2,z1=gpuBox.c[2]+gpuBox.d/2;
      spatialDimension(dimLayer,[x,y,z0],[x,y,z1],`${Math.round(gpuBox.d)}mm 包络 / N6 发布范围 ${limits.gpuMm.publishedMin}–${limits.gpuMm.publishedMax}mm`,'inferred',0,15);
    }
    model.labels.forEach(item=>spatialCallout(labelLayer,item.anchor,item.text,item.dx,item.dy));
    if(spatialState.showRoutes)drawRoutes(lineLayer);

    const origin={x:680,y:560},axisData=[[[42,0,0],'W', 'var(--viz-series-6)'],[[0,42,0],'H','var(--viz-series-4)'],[[0,0,42],'D','var(--viz-series-1)']],base=spatialProject([0,0,0]);
    axisData.forEach(([point,label,color])=>{
      const p=spatialProject(point),vx=p.x-base.x,vy=p.y-base.y,length=Math.hypot(vx,vy)||1,x2=origin.x+vx/length*38,y2=origin.y+vy/length*38;
      overlay.appendChild(spatialEl('line',{x1:origin.x,y1:origin.y,x2:x2.toFixed(2),y2:y2.toFixed(2),class:'spatial-axis',stroke:color}));
      overlay.appendChild(spatialEl('text',{x:(x2+vx/length*7).toFixed(2),y:(y2+vy/length*7).toFixed(2),'text-anchor':'middle',class:'spatial-axis-label',fill:color},label));
    });
    overlay.appendChild(spatialEl('text',{x:24,y:27,class:'svg-label'},'毫米比例模型 · 透明外壳 · 空间规划视图'));
    overlay.appendChild(spatialEl('text',{x:24,y:48,class:'svg-dim'},'内部安装点与间隙是依说明书的推算，不可作为开孔 / 定制线材尺寸'));

    const routes=spatialState.routing&&spatialState.routing.cables?spatialState.routing.cables:[];
    const routeStrip=spatialState.showRoutes&&routes.length
      ? `<div data-source="inferred"><b>走线折线 · 重建推算</b><span>${routes.length} 条线路按 routing.json 的接口锚点与航点图求解；圆点是声明过的穿线孔，虚线框是被占住的插拔净空。手册未标注接口坐标，折线不可用于定制线材下单。</span></div>`
      : '';
    const psuStandard=c.psu.form==='ATX'?`ATX 150×86×${c.psu.length}mm`:'SFX 125×63.5×100mm',coolerLimit=coolerPlanningLimit(c),ramCount=ramModuleCount(c);
    const bootVisual=c.boot==='bay'?'2.5″ SATA Boot ·1':c.boot==='usbssd'?'外置 USB Boot SSD ·1':'980 PRO #1 作 Boot';
    $('#spatial-data-strip').innerHTML=`
      <div data-source="official"><b>官方规格证据 · N6 PDF p2</b><span>${env.w}W × ${env.d}D × ${env.h}H mm（含 6mm 底座）；所有毫米坐标只存在于 data/cases/jonsbo-n6/geometry.json 一处，等轴视图、碰撞检测与温度场读同一份。原页可在“官方手册证据”中查看，未与 3D 坐标注册叠加。</span></div>
      <div data-source="official"><b>官方安装关系 · N6 p6–10 / p15 / p17</b><span>ATX 后上、SFX 前/后下、双电源、前置 240 冷排、九盘横向单排；65–160 / 275–320 仅为范围。</span></div>
      <div data-source="standard"><b>已显示的板上与存储件</b><span>i5-14500 ·1；DDR5 ·${ramCount}；980 PRO M.2 ·2；${bootVisual}；3.5″ HDD ·${c.disks}。</span></div>
      <div data-source="standard"><b>厂商 / 标准零件包络</b><span>mATX 244×244mm（ASUS p11）；${psuStandard}；3.5\" HDD 101.6×147×26.1mm。</span></div>
      <div data-source="official"><b>下层结构关系 · N6 §8.1–8.3 / §13.1</b><span>左侧风扇架 4 螺丝可拆；接背板四路供电需先拆它；装下置电源时由随箱电源架取代，不再装回。背板供电口排列为 SATA×2 + PATA×2。</span></div>
      ${routeStrip}
      <div data-source="inferred"><b>规划重建 · 不可量内部间隙</b><span>${topologyLabel(c)}；${c.cooler.name} ${c.cooler.height?c.cooler.height+'mm':'冷头 / 泵包络'} / 规划限高 ${coolerLimit}mm；托架钢框、背板 PCB 板形、风扇架 / 电源架板形与安装孔位手册均未标注，图中为包络；锚点、卡高、冷管与线材弯折非厂商 CAD。</span></div>`;
  }
  function resetSpatialView(){spatialState.yaw=-.72;spatialState.pitch=-.46;spatialState.zoom=.93;if(spatialState.config)renderSpatial(spatialState.config);}
  function installSpatialInteraction(){
    const svg=$('#iso-svg');
    svg.addEventListener('pointerdown',event=>{if(event.button!==0)return;spatialState.dragging=true;spatialState.x=event.clientX;spatialState.y=event.clientY;svg.setPointerCapture(event.pointerId);});
    svg.addEventListener('pointermove',event=>{if(!spatialState.dragging)return;const dx=event.clientX-spatialState.x,dy=event.clientY-spatialState.y;spatialState.x=event.clientX;spatialState.y=event.clientY;spatialState.yaw+=dx*.009;spatialState.pitch=Math.max(-1.28,Math.min(1.28,spatialState.pitch-dy*.009));if(spatialState.config)renderSpatial(spatialState.config);});
    const stop=event=>{spatialState.dragging=false;if(svg.hasPointerCapture&&svg.hasPointerCapture(event.pointerId))svg.releasePointerCapture(event.pointerId);};
    svg.addEventListener('pointerup',stop);svg.addEventListener('pointercancel',stop);
    svg.addEventListener('wheel',event=>{event.preventDefault();spatialState.zoom=Math.max(.58,Math.min(1.55,spatialState.zoom*Math.exp(-event.deltaY*.001)));if(spatialState.config)renderSpatial(spatialState.config);},{passive:false});
    svg.addEventListener('dblclick',resetSpatialView);
    svg.addEventListener('keydown',event=>{
      const key=event.key;
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','_','0'].includes(key))return;
      event.preventDefault();
      if(key==='ArrowLeft')spatialState.yaw-=.1;if(key==='ArrowRight')spatialState.yaw+=.1;if(key==='ArrowUp')spatialState.pitch=Math.min(1.28,spatialState.pitch+.1);if(key==='ArrowDown')spatialState.pitch=Math.max(-1.28,spatialState.pitch-.1);
      if(key==='+'||key==='=')spatialState.zoom=Math.min(1.55,spatialState.zoom*1.08);if(key==='-'||key==='_')spatialState.zoom=Math.max(.58,spatialState.zoom/1.08);if(key==='0')return resetSpatialView();
      if(spatialState.config)renderSpatial(spatialState.config);
    });
  }
  function renderCase(c,p,ev){
    const placement=psuPlacement(c),psuRect=$('#psu-shape rect'),pt1=$('#psu-svg-name'),pt2=$('#psu-svg-pos'),atxUpper=['rearUpperATX','rearUpperATX_plus_bottomSFX','invalidATXBottom'].includes(placement),frontSfx=['frontSFX','frontSFX_plus_bottomSFX'].includes(placement);
    if(atxUpper){psuRect.setAttribute('x',130);psuRect.setAttribute('y',62);psuRect.setAttribute('width',275);psuRect.setAttribute('height',112);pt1.setAttribute('x',150);pt1.setAttribute('y',94);pt2.setAttribute('x',150);pt2.setAttribute('y',120);}
    else if(frontSfx){psuRect.setAttribute('x',540);psuRect.setAttribute('y',62);psuRect.setAttribute('width',120);psuRect.setAttribute('height',100);pt1.setAttribute('x',548);pt1.setAttribute('y',92);pt2.setAttribute('x',548);pt2.setAttribute('y',116);}
    else {psuRect.setAttribute('x',130);psuRect.setAttribute('y',330);psuRect.setAttribute('width',145);psuRect.setAttribute('height',54);pt1.setAttribute('x',142);pt1.setAttribute('y',352);pt2.setAttribute('x',142);pt2.setAttribute('y',374);}
    pt1.textContent=c.psu.form==='ATX'?`${c.psu.name.replace('Seasonic ','')} · ${c.psu.length}mm`:`${c.psu.name.replace(/^(Corsair|SilverStone|FSP) /,'')} · SFX ${c.psu.length}mm`;
    pt2.textContent=`${topologyLabel(c)} · 规划限高 ${coolerPlanningLimit(c)}mm`;
    $('#case-mode').textContent=topologyLabel(c);
    const ramCount=ramModuleCount(c),ramInstalled=[false,true,false,ramCount===2];
    ramInstalled.forEach((installed,index)=>$('#ram-slot-'+(index+1)).dataset.installed=String(installed));
    $('#side-ram-1').dataset.installed='true';$('#side-ram-2').dataset.installed=String(ramCount===2);
    const m2Text=c.boot==='m2'?'980 PRO ×2 · 1 启动 / 1 待用':'980 PRO ×2 · ZFS 镜像';
    $('#ram-svg-label').textContent=`DDR5 ×${ramCount} · ${c.ram.height}mm`;
    $('#m2-svg-label').textContent=m2Text;$('#side-ram-label').textContent=`DDR5 ×${ramCount}`;$('#side-m2-label').textContent=m2Text;
    const cb=$('#cooler-box'),cf=$('#cooler-fan');
    if(c.cooler.type==='塔式风冷'){cb.setAttribute('x',302);cb.setAttribute('y',145);cb.setAttribute('width',88);cb.setAttribute('height',155);cf.setAttribute('cx',346);cf.setAttribute('cy',220);cf.setAttribute('r',32);}
    else if(c.cooler.type==='水冷'){cb.setAttribute('x',296);cb.setAttribute('y',198);cb.setAttribute('width',94);cb.setAttribute('height',82);cf.setAttribute('cx',343);cf.setAttribute('cy',239);cf.setAttribute('r',30);}
    else {const s=c.cooler.height>=57?118:100;cb.setAttribute('x',343-s/2);cb.setAttribute('y',184);cb.setAttribute('width',s);cb.setAttribute('height',106);cf.setAttribute('cx',343);cf.setAttribute('cy',237);cf.setAttribute('r',s*.36);}
    $('#cooler-svg-name').textContent=`${c.cooler.name.split(' ')[0]} · ${c.cooler.type}${c.cooler.height?' '+c.cooler.height+'mm':''}`;
    $('#gpu-shape').classList.toggle('is-hidden',!c.gpu.tgp);$('#gpu-svg-name').textContent=`${c.gpu.name} · ${c.gpu.length}mm · ${c.gpu.slots} 槽`;
    const gw=Math.min(430,Math.max(120,c.gpu.length/275*390));$('#gpu-box').setAttribute('width',gw);
    const hbaVisible=hasHba(c)||c.preserve,frontConflict=frontSfx&&c.frontRequested,frontVisual=c.frontRequested;$('#hba-shape').classList.toggle('is-hidden',!hbaVisible);$('#hba-shape').dataset.installed=String(hasHba(c));$('#hba-svg-name').textContent=hasHba(c)?'LSI 9300-8i · IT Mode':'底部 PCIe ×4 · HBA 预留';$('#front-fan-shape').classList.toggle('is-hidden',!frontVisual);$('#front-fan-shape').dataset.conflict=String(frontConflict);$('#rear-fan-shape').classList.toggle('is-hidden',!c.rear);$('#air-arrows').classList.toggle('is-hidden',!c.front);$('#front-fan-svg-label').textContent=frontConflict?(c.cooler.fit==='front240'?'保守冲突：240 冷排 × 前置 SFX':'待实测：完整前风扇 × 前置 SFX'):c.cooler.fit==='front240'?'240 冷排 + 2×120':'2×140 进风';
    $('#top-usb-boot').classList.toggle('is-hidden',c.boot!=='usbssd');$('#side-usb-boot').classList.toggle('is-hidden',c.boot!=='usbssd');
    $('#hdd-fans-shape').dataset.installed=String(c.drive);$('#side-hdd-fans').dataset.installed=String(c.drive);$('#hdd-fans-label').textContent=c.drive?'盘区 2×120 · 已装':'盘区 2×120 · 另购';$('#side-hdd-fans-label').textContent=c.drive?'盘区 2×120 · 已装':'盘区 2×120 · 未装';
    updateTopThermalMap(c,p,ev);
    const host=$('#drive-svg-slots');let cells='';
    for(let i=0;i<9;i++){const x=65+i*65,y=475,boot=c.boot==='bay'&&i===8,active=i<c.disks,label=boot&&active?'D9+BOOT!':boot?'2.5 BOOT':active?'D'+(i+1):'—';cells+=`<g class="drive-cell" data-active="${active}" data-boot="${boot}"><rect x="${x}" y="${y}" width="52" height="92" rx="2"></rect><text x="${x+26}" y="${y+50}" text-anchor="middle">${label}</text></g>`;} host.innerHTML=cells;

    const isTower=c.cooler.type==='塔式风冷',isAio=c.cooler.type==='水冷',mainSfx=frontSfx||placement==='bottomSFX';
    $('#side-psu-atx').classList.toggle('is-hidden',!atxUpper);$('#side-psu-sfx').classList.toggle('is-hidden',!mainSfx);
    $('#side-psu-sfx').setAttribute('transform',placement==='bottomSFX'?'translate(-370 330)':'');$('#side-sfx-text').textContent=placement==='bottomSFX'?'SFX 后下':'SFX 前置';
    const freeOverhead=!overheadPsu(c);$('#side-sfx-clearance').classList.toggle('is-hidden',!freeOverhead);$('#side-sfx-clearance-text').classList.toggle('is-hidden',!freeOverhead);
    $('#side-psu-extra').innerHTML=c.psuPosition==='dual'?'<rect x="165" y="422" width="112" height="70"></rect><text x="178" y="454">第二颗 SFX</text><text x="178" y="476">背板供电</text>':'';
    $('#side-cooler-low').classList.toggle('is-hidden',isTower||isAio);$('#side-cooler-tower').classList.toggle('is-hidden',!isTower);$('#side-cooler-aio').classList.toggle('is-hidden',!isAio);
    $('#side-gpu').classList.toggle('is-hidden',!c.gpu.tgp);$('#side-hba').classList.toggle('is-hidden',!hbaVisible);$('#side-hba').dataset.installed=String(hasHba(c));$('#side-hba-name').textContent=hasHba(c)?'底部 HBA':'底部 HBA 预留';
    $('#side-air').classList.toggle('is-hidden',!c.front);$('#side-gpu-name').textContent=c.gpu.tgp?`${c.gpu.name} · ${c.gpu.length}mm`:'GPU';

    let sideCells='',rearCells='';
    for(let i=0;i<9;i++){
      const boot=c.boot==='bay'&&i===8,active=i<c.disks,label=boot&&active?'D9+BOOT!':boot?'2.5 BOOT':active?`D${i+1}`:`—`;
      const sx=90+i*58,sy=420;sideCells+=`<g class="side-drive" data-active="${active}" data-boot="${boot}"><rect x="${sx}" y="${sy}" width="46" height="105"></rect><text x="${sx+23}" y="${sy+57}" text-anchor="middle">${label}</text></g>`;
      const rx=90+i*64,ry=95;rearCells+=`<g class="rear-drive" data-active="${active}" data-boot="${boot}"><rect x="${rx}" y="${ry}" width="54" height="150"></rect><text x="${rx+27}" y="${ry+80}" text-anchor="middle">${label}</text></g>`;
    }
    $('#side-drive-slots').innerHTML=sideCells;$('#rear-drive-slots').innerHTML=rearCells;
    $('#rear-data-source').textContent=hasHba(c)?'LSI 9300-8i · 8 口':c.disks<=4?'4×SATA 原生':'4×SATA 原生';
    $('#rear-data-source-2').textContent=hasHba(c)?(c.boot==='bay'&&c.disks<9?'Boot → 主板 SATA 1':c.disks===9?'第 9 盘 → 主板 SATA':'2×SFF-8643 分线'):c.disks<=4?'SlimSAS 暂不用':'SlimSAS → 4×SATA';
    const harness=backplaneHarnessCount(c);$('#rear-harness-text').textContent=c.psuPosition==='dual'?`背板 SFX 约 ${harness} 条 · 不与主 PSU 相加`:harness>=4?'PSU 四条独立外围线':'预计 '+harness+' 条 · 需补 '+(4-harness)+' 条';
    renderSpatial(c,ev.geometry,ev.routing);
  }
  function renderOverview(c,p,a,fit,ev){
    $('#kpi-wall').textContent=Math.round(p.wall)+' W';$('#kpi-wall-note').textContent=$('#workload-select').selectedOptions[0].text+' · 估算 ±3–8W';
    $('#kpi-heat').textContent=Math.round(p.dc)+' W';$('#kpi-btu').textContent=`约 ${Math.round(p.wall*3.412)} BTU/h 室内热负载`;
    $('#kpi-noise').textContent=a.noise+' dBA';$('#kpi-noise-note').textContent=`${c.disks>3?'多盘寻道/共振':'硬盘与风扇'}主导 · 实际 ±5dB`;
    // Same ranges as the air-balance card, from the same evaluation — the KPI can no
    // longer show a confident single number the model never produced.
    const cpuT=nodeTemp(ev,'cpu'),hddT=nodeTemp(ev,'hdd'),gpuT=nodeTemp(ev,'gpu');
    $('#kpi-temp').textContent=`CPU ${rangeC(cpuT)}`;
    $('#kpi-temp-note').textContent=`HDD ${rangeC(hddT)} · GPU ${gpuT?rangeC(gpuT):'—'} · 区间非误差棒`;
    $('#kpi-headroom').textContent=Math.round(p.headroom*100)+'%';$('#kpi-headroom-note').textContent=p.dual?`双路中较紧一路的余量 · 主机 ${Math.round(p.mainPeak)}W / 盘路 ${Math.round(p.drivePeak)}W`:`病态峰值 ${Math.round(p.pathological)}W DC / ${c.psu.watts}W`;
    const remain=priceModel(c,false);$('#kpi-price').textContent=fmt(remain);
    const levelText={ok:'兼容：推荐组合',warn:'有条件：需处理警告',bad:'不兼容 / 不建议'};$('#fit-chip').dataset.level=fit.level;$('#fit-chip').textContent=levelText[fit.level];
    $('#verdict-title').textContent=fit.level==='ok'?'推荐：可直接装':fit.level==='warn'?'可装，但先解决条件':'当前组合不应下单';
    const items=[...fit.issues.map(x=>`<li class="status-bad">${x}</li>`),...fit.warnings.map(x=>`<li class="status-warn">${x}</li>`),...fit.oks.map(x=>`<li class="status-ok">${x}</li>`)];$('#verdict-list').innerHTML=items.join('');
    let routeTitle='ATX 850W + AXP90-X53 FULL',routeCopy='这是机械风险最低的主路线：140mm ATX 电源满足长度，53mm 下压散热器余约 12mm，未来 A4000 单槽可与底部 HBA 共存。';
    if(c.psu.form==='SFX') {routeTitle='SFX + NH-U9S 空间路线';routeCopy=`SFX 的价值是释放 CPU 上方，让 125mm 塔式风冷工作；它不是为了省电，价格更高。当前 ${c.psu.name}：${c.psu.certification} · ${c.psu.modular} · 背板可用独立外围线 ${c.psu.harness} 根（需 4 根）${c.psu.peripheralSockets?` · SATA/PATA 插座 ${c.psu.peripheralSockets} 个${c.psu.peripheralSockets<4?'（插座已是上限，加线无处可插）':''}`:''}。`;}
    if(c.psuPosition==='dual'){routeTitle='双电源实验路线';routeCopy='N6 手册展示了双电源机械位置，但没有提供冗余切换或 PS_ON 同步电路。它只适合分担硬盘背板负载；除非未来 GPU + 九盘同时高负载，否则单颗优质电源更安静、更省线、更容易维护。';}
    if(c.cooler.type==='水冷'){routeTitle='水冷作为有条件分支';routeCopy=c.cooler.fit==='front240'?'N6 手册明确列出前置 240mm 冷排位；但厚度、冷管与 GPU 尾部余量没有标数，仍需实物复核。对 90W i5-14500 并非必要。':'后置 120mm 只有风扇位标注，冷排兼容未获明确承诺；泵、冷管、搬家与老化风险高于风冷。';}
    $('#route-title').textContent=routeTitle;$('#route-copy').textContent=routeCopy;
    const bootPurchase=c.boot==='bay'?'240–500GB SATA 启动 SSD':c.boot==='usbssd'?'外置 USB 3.x 启动 SSD + 固定短线':'980 PRO #1 作 TrueNAS Boot；#2 只能单盘 / 待用（无需另购启动盘）';
    const frontPurchase=['frontSFX','frontSFX_plus_bottomSFX'].includes(psuPlacement(c))?'前置 SFX 已占风扇区；不购买前置 2×140':c.cooler.fit==='front240'?'240 冷排自带 2×120 风扇；不要再买 2×140':'前置 2×140mm PWM + 风扇分线';
    const rearPurchase=c.rear&&c.coolerKey!=='cooler.aio-120-experimental'?'后置 1×120mm PWM 排风':(['frontSFX','frontSFX_plus_bottomSFX'].includes(psuPlacement(c))&&c.cooler.type==='塔式风冷'?'建议增加后置 1×120mm PWM 排风':null);
    const next=[`${c.psu.name}（${range(c.psu.price)}）`,...(c.psuPosition==='dual'?[`${c.secondaryPsu.name}（${range(c.secondaryPsu.price)}）`,`PS_ON 同步模块 / 继电器（型号与接线待核）`]:[]),`${c.cooler.name}（${range(c.cooler.price)}）`,`${c.ram.name}（${range(c.ram.price)}）`,bootPurchase,`24TB CMR HDD ×${c.disks}：每块约 ¥4,200–4,950`,frontPurchase,...(rearPurchase?[rearPurchase]:[]),c.drive?'盘区 2×120mm 已计入':'盘区 2×120mm PWM（N6 仅列安装位，按需另购）',...(c.psuPosition==='dual'?['背板专用 SFX 必须独自提供四条独立外围线']:backplaneHarnessCount(c)<4?['补同型号 PSU 外围线（先向厂商核对针脚）']:[])];$('#next-buy-list').innerHTML=next.map(x=>`<li>${x}</li>`).join('');
    renderCase(c,p,ev);
  }
  function metricRows(data,max){return Object.entries(data).map(([name,v])=>{const val=typeof v==='object'?v.value:v,level=typeof v==='object'?v.level:'ok';return `<div class="metric-row"><span>${name}</span><div class="metric-track"><div class="metric-fill" data-level="${level}" style="width:${Math.min(100,val/max*100)}%"></div></div><strong>${Math.round(val)}${name.includes('噪音')?' dBA':'°C'}</strong></div>`;}).join('');}
  /** Temperature bars draw the band, not a point: the model only ever gives a band. */
  function rangeRows(rows,max){
    return rows.map(row=>{
      const lo=clamp(row.temp.lo/max*100,0,100),hi=clamp(row.temp.hi/max*100,0,100);
      return `<div class="metric-row"><span>${row.name}</span><div class="metric-track"><div class="metric-band" data-level="${row.level}" style="margin-left:${lo.toFixed(1)}%;width:${Math.max(1.5,hi-lo).toFixed(1)}%"></div></div><strong>${rangeC(row.temp)}</strong></div>`;
    }).join('');
  }
  /** Worst-case end drives the verdict: an unacceptable upper bound is the finding. */
  const tempLevel=(temp,warn,bad)=>temp.hi>bad?'bad':temp.hi>warn?'warn':'ok';
  function renderThermal(c,p,a,ev){
    const thermal=ev.thermal;
    $('#thermal-ambient').textContent=(thermal?thermal.ambientC:c.ambient)+'°C';
    const limitsByNode={cpu:[80,90],hdd:[45,50],gpu:[80,88],hba:[70,85],psu:[60,75]};
    const rows=(thermal?thermal.components:[]).map(node=>{
      const [warn,bad]=limitsByNode[node.id]||[70,85];
      return {name:`${node.label} · ${Math.round(node.watts)}W × θ ${node.thetaKPerW.lo}–${node.thetaKPerW.hi}`,temp:node.tempC,level:tempLevel(node.tempC,warn,bad)};
    });
    $('#temperature-bars').innerHTML=rows.length?rangeRows(rows,100):'<p class="lab-note">当前配置没有可定温的部件。</p>';
    const colors=['var(--viz-series-2)','var(--viz-series-5)','var(--viz-series-6)','var(--viz-series-4)','var(--viz-series-1)','var(--viz-series-3)'],parts=[['CPU',p.cpu],['HDD',p.hdd],['GPU',p.gpu],['主板/风扇',p.base],['HBA',p.hba],['PSU 废热',p.psuWaste]].filter(x=>x[1]>0);const heatDenom=Math.max(1,p.dc+p.psuWaste);$('#heat-split').innerHTML=parts.map((x,i)=>`<div class="heat-segment" style="width:${x[1]/heatDenom*100}%;background:${colors[i%colors.length]}">${x[0]} ${Math.round(x[1])}W</div>`).join('');
    $('#noise-total').textContent=a.noise+' dBA';const noiseData={};Object.entries(a.parts).filter(x=>x[1]>0).forEach(([k,v])=>noiseData[k+'噪音']={value:v,level:v>45?'warn':'ok'});$('#noise-bars').innerHTML=metricRows(noiseData,55);
    const fanAdvice=[];fanAdvice.push(['frontSFX','frontSFX_plus_bottomSFX'].includes(psuPlacement(c))?'前置 SFX 与完整 2×120/140 或 240 冷排按保守互斥规划；这是由手册安装面重叠推断，不是厂商公布的共存矩阵。':c.cooler.fit==='front240'?'前置 240 冷排配 2×120mm 风扇；不能再叠加 2×140。':c.front?'前置 2×140mm：400–700rpm 持续低转，给下压散热器和主板送冷风。':'后上置 ATX 路线应恢复前置 2×140mm。');fanAdvice.push(c.rear?(c.coolerKey==='cooler.aio-120-experimental'?'后置 120 位已由实验性冷排占用。':'后置 1×120mm 排风已启用；对 SFX + 塔式风冷路线有益。'):rearFanAvailable(c)?'后置 120mm 位可用但尚未安装。':'后上位被 ATX 电源占用，不规划后置 120mm 风扇。');fanAdvice.push(c.drive?'盘区 2×120mm 已启用：按最高 HDD 温度控制，目标 30–45°C。':'盘区 2×120mm 未安装：N6 手册只列安装位，企业盘投入使用前建议另购低速 PWM 风扇。');fanAdvice.push(c.gpu.tgp||hasHba(c)?(c.side?'侧面 2×120mm 已启用：对 GPU/HBA 横向送风；下置 SFX 时只按未拆的一侧规划。':hasHba(c)?'已装被动散热 HBA，应增加至少一组 120mm 定向侧吹。':'后续装 GPU 时增加侧面 2×120mm；先不买也可以。'):'无 GPU、无 HBA 时可暂不装侧风扇。');fanAdvice.push(c.psuPosition==='dual'?`双电源按两颗效率分别估算废热约 ${p.psuWaste.toFixed(0)}W；噪音用各 PSU 的 Cybenetics/规划 dBA（低于 fan-off 按停转）。`:`主 PSU ${Math.round(p.mainDc)}W / fan-off ${c.psu.fanOff||0}W；噪音 ${c.psu.noiseEvidence||'unknown'} ${c.psu.noiseDba??'—'} dBA（开放台架，非机箱内）。废热约 ${p.psuWaste.toFixed(0)}W。`);$('#fan-advice').innerHTML='<ul class="compact-list">'+fanAdvice.map(x=>`<li>${x}</li>`).join('')+'</ul>';
    const idleMain=23+5+12+c.gpu.idle+(hasHba(c)?12:0)+(c.psuPosition==='dual'&&c.dualStart==='sync'?1:0),idleDrive=6.22+(c.psuPosition==='dual'?2:0),idleWall=c.psuPosition==='dual'?wallForLoads(c,idleMain,idleDrive):wallForPsu(c.psuKey,idleMain+idleDrive);
    const plMain=35+c.pl1+c.gpu.idle+(hasHba(c)?12:0),plDrive=c.disks*8.5+(c.psuPosition==='dual'?2:0),plWall=c.psuPosition==='dual'?wallForLoads(c,plMain,plDrive):wallForPsu(c.psuKey,plMain+plDrive);
    const scenarios=[['当前负载',p.wall],['1盘旋转待机',idleWall],['CPU PL1',plWall],['同时起盘峰值',p.pathologicalWall]];$('#power-scenarios').innerHTML=scenarios.map(([n,w])=>`<div><span>${n}</span><strong>${Math.round(w)} W</strong><small>墙上估算 · ${Math.round(w*3.412)} BTU/h</small></div>`).join('');renderThermalField(c,ev);
  }
  function portPlan(c){
    const hba=hasHba(c),ports=[];
    for(let i=1;i<=c.disks;i++){let controller,cable;if(hba){controller=i<=8?'LSI 9300-8i':'主板 SATA 1';cable=i<=4?'HBA SFF-8643 A':i<=8?'HBA SFF-8643 B':'SATA 单线';}else if(i<=4){controller=`主板 SATA ${i}`;cable='SATA 数据线';}else{controller=`SlimSAS SATA ${i-4}`;cable='SlimSAS → 4×SATA';}ports.push({name:`HDD ${i}`,controller,cable});}
    if(c.boot==='bay'&&c.disks<9){const controller=hba?'主板 SATA 1':c.disks<4?`主板 SATA ${c.disks+1}`:`SlimSAS SATA ${c.disks-3}`,cable=hba||c.disks<4?'SATA 数据线':'SlimSAS → 4×SATA';ports.push({name:'Boot SSD',controller,cable});}
    if(c.boot==='m2')ports.push({name:'Boot SSD',controller:'主板 M.2_1 · PCIe 4.0 ×4',cable:'板载连接 · 无数据线'});
    if(c.boot==='usbssd')ports.push({name:'Boot SSD',controller:'后置 USB 3.x',cable:'外置短线 · 建议固定防误拔'});
    return ports;
  }
  function renderWiring(c){
    const hba=hasHba(c),ports=portPlan(c),bootLabel=c.boot==='bay'?' + SATA Boot':c.boot==='m2'?' + M.2 Boot':' + USB Boot';$('#wiring-title').textContent=`${c.disks} HDD${bootLabel} 接线方案`;$('#controller-badge').textContent=hba?'需要 HBA':'无需 HBA';
    $('#port-map').innerHTML=ports.map(p=>`<div class="port-card"><b>${p.name}</b><span>${p.controller}</span><small>${p.cable}</small></div>`).join('');
    const devices=sataDeviceCount(c);let note=hba?'主板底部插槽是 PCIe 4.0 ×4 电气；LSI 9300-8i 为 PCIe 3.0 ×8 卡，装入后通常按 Gen3 ×4 协商（理论约 3.9GB/s），带 8 块机械盘通常足够。两条 SFF-8643→4×SATA 可接 8 块 HDD；额外第 9 HDD 或 SATA Boot 走主板 SATA。':devices<=4?'全部 SATA 设备使用主板 4 个原生 SATA；不需要 SlimSAS，也不需要 HBA。':'前 4 个 SATA 设备用原生 SATA，其余用主板 SlimSAS 转 4×SATA；GPU ×16 与底部 ×4 均保留。';
    if(c.boot==='bay')note+=' 第 9 盘位保留给 SATA 启动 SSD，因此最多 8 块数据 HDD。';
    if(c.boot==='m2')note+=' 980 PRO #1 被 TrueNAS 独占；#2 不能单独构成 ZFS 镜像。';
    if(c.boot==='usbssd')note+=' 外置 USB SSD 不占 SATA 口和盘位；需固定短线并避免误拔。';
    $('#wiring-notes').textContent=note;
    const harness=backplaneHarnessCount(c);$('#harness-count').textContent=c.psuPosition==='dual'?`${c.secondaryPsu.name} · ${harness} 条已确认`:`${harness} 条外围线束`;$('.wire-4').dataset.missing=String(harness<4);const hw=$('#harness-warning');hw.dataset.level=harness<4?'warn':'ok';hw.textContent=c.psuPosition==='dual'?`双电源时，四个背板供电口应全部由专供背板的 ${c.secondaryPsu.name} 提供，不能把主电源与第二电源的线束相加。当前模型只有 ${harness} 条已确认独立外围线；锁定具体型号并补齐同型号原厂/授权线束前不可下单。还需要 PS_ON 同步件，且这不是冗余热备。`:(harness<4?`N6 手册建议 2×SATA Power + 2×Molex 四口全插，且每口使用独立 PSU 线。${c.psu.name} 原盒线束按公开清单保守估计只有 ${harness} 条：少盘阶段先向 JONSBO 确认，满盘前补与该型号针脚明确兼容的原厂/授权线。禁止混用不同品牌或代际模组线。`:'四条独立外围线可覆盖背板四口；仍要逐一核对实际包装与模组针脚，不要用同一根菊链接两个背板口。');
    let rows='';for(let n=1;n<=limits.trays;n++){
      const bayBootValid=c.boot!=='bay'||n<limits.trays,devices=n+(c.boot==='bay'&&bayBootValid?1:0),needHba=c.hbaMode==='always'||devices>sataCeiling(c);
      const boot=c.boot==='bay'?(bayBootValid?'第 9 托架 SATA SSD':'不可用：托架已占满'):c.boot==='m2'?'980 PRO #1 · M.2':'外置 USB SSD';
      const data=needHba?'HBA 8口 + 主板 SATA':devices<=limits.onboardSata?'原生 SATA':`${Math.min(limits.onboardSata,devices)}×SATA + SlimSAS 分线`;
      const advice=!bayBootValid?'请改用 M.2 / USB 启动，或降为 8 HDD':n===1?'单盘无冗余，必须另备份':n===2?'可做 2盘镜像':n<=4?'按镜像对扩容':n<=8?'建议镜像对；8 HDD + SATA Boot 需 HBA':'占满9盘位，维护与散热压力最高';
      rows+=`<tr data-selected="${n===c.disks}"${!bayBootValid?' class="matrix-invalid"':''}><td>${n}</td><td>${data}</td><td>${needHba?'LSI 9300-8i':'主板 W680'}</td><td>${boot}</td><td>${advice}</td></tr>`;
    }$('#drive-matrix').innerHTML=rows;
  }
  function renderGpu(c){
    const g=c.gpu,v=gpuVerdict(g,c);$('#gpu-title').textContent=g.name;$('#gpu-detail').innerHTML=`<p>${g.ai}</p><ul class="compact-list"><li>${g.vram?g.vram+'GB VRAM':'无独显'} · ${g.tgp}W TGP · ${g.cooling}</li><li>${g.length?g.length+'mm / '+g.slots+' 槽':'不占空间'}</li><li>参考价 ${range(g.price)}${g.newPrice?'；全新库存约 '+range(g.newPrice):''}</li><li class="status-${v.level}">${v.text}：${v.reason}</li></ul>`;
    $('#gpu-safe-basis').textContent='N6 只发布 275–320mm 范围，未给端点拓扑；>275mm 一律标条件区，保留 HBA 时 ≤2 槽';
    const scores=[['显存余量',g.vram?Math.min(100,g.vram/24*100):0,(g.vram||0)+'GB'],['能效',g.tgp?Math.min(100,(g.vram/g.tgp)*450):100,g.tgp?g.tgp+'W':'最高'],['扩展友好',g.slots<=2&&g.length<=275?100:g.length<=275?55:20,g.slots?g.slots+' 槽':'满分']];$('#gpu-score').innerHTML=scores.map(([n,s,val])=>`<div><span>${n}</span><b>${val}</b><div class="metric-track"><div class="metric-fill" style="width:${s}%"></div></div></div>`).join('');
    let rows='';Object.entries(gpus).forEach(([k,x])=>{if(k==='gpu.none')return;const vv=gpuVerdict(x,c);rows+=`<tr data-selected="${k===c.gpuKey}"><td>${x.name}</td><td>${x.vram}GB</td><td>${x.tgp}W</td><td>${x.length}mm / ${x.slots}槽</td><td>${x.cooling}<br><span class="text-muted">满载约 ${x.noise}dBA</span></td><td>${range(x.price)}${x.newPrice?'<br>全新 '+range(x.newPrice):''}<br><small>${x.official}</small></td><td class="status-${vv.level}">${vv.text}<br><small>${vv.reason}</small></td></tr>`;});$('#gpu-table').innerHTML=rows;
  }
  function renderProducts(c){
    const psuRef=['psu.seasonic-focus-gx-850-v5','psu.seasonic-focus-gx-750-v5'].includes(c.psuKey)?officialProducts.focus:null;
    const coolerRef=c.coolerKey==='cooler.thermalright-axp90-x53-full'?officialProducts.axp90:null;
    const gpuRef=c.gpuKey==='gpu.rtx-a4000-16gb'?officialProducts.a4000:null;
    const cards=[
      {name:'JONSBO N6',status:'已购 · ¥629',ref:officialProducts.n6},
      {name:'ASUS W680M-ACE SE',status:'已购 · ¥2,799',ref:officialProducts.board},
      {name:'Intel Core i5-14500',status:'已购 · ¥1,380',ref:officialProducts.cpu},
      {name:c.ram.name,status:'待购 · '+range(c.ram.price),ref:null,note:`料号 ${c.ram.mpn||'—'}；3D 显示 ${c.ram.height}mm DIMM 包络与 ${ramModuleCount(c)} 条内存`},
      {name:'Samsung 980 PRO ×2',status:'已有 · ¥0',ref:officialProducts.ssd,note:c.boot==='m2'?'#1 TrueNAS Boot；#2 单盘 / 待用':'两块都已在主板 M.2 位显示；规划 ZFS 镜像'},
      {name:c.psu.name,status:'待购 · '+range(c.psu.price),ref:psuRef,note:psuRef?'':'当前备选型号官方图尚未缓存；不用其他型号冒充'},
      ...(c.psuPosition==='dual'?[{name:c.secondaryPsu.name,status:'双电源分支 · '+range(c.secondaryPsu.price),ref:null,note:c.secondaryPsu.confidence==='unknown'?'仅有 SFX 尺寸/功率包络，线束与效率未知':'第二颗 PSU 需独立核对四条背板线与 PS_ON 同步；当前未缓存对应官方图'}]:[]),
      {name:c.cooler.name,status:'待购 · '+range(c.cooler.price),ref:coolerRef,note:coolerRef?'':'当前备选型号官方图尚未缓存；3D 仅画尺寸包络'},
      {name:`24TB Exos X24 / 同级 ×${c.disks}`,status:'待购 · '+fmt(4500*c.disks)+' 中位数',ref:officialProducts.hdd},
      {name:c.gpu.name,status:c.gpu.tgp?'未来 · '+range(c.gpu.price):'暂不安装',ref:gpuRef,note:gpuRef?'':c.gpu.tgp?'当前 GPU 型号官方图尚未缓存；不用 A4000 图冒充':'不占 PCIe 与散热空间'}
    ];
    $('#product-gallery').innerHTML=cards.map(card=>{
      const ref=card.ref,visual=ref&&ref.image?`<img src="${ref.image}" alt="${card.name} 厂商官方产品图" loading="lazy"><div class="product-placeholder">图片未加载；可打开官方页</div>`:`<div class="product-placeholder">${card.note||ref?.note||'尚无对应官方缓存图'}</div>`;
      const missing=ref&&ref.image?'false':'true',link=ref&&ref.page?`<a href="${ref.page}" target="_blank" rel="noreferrer">查看厂商官方页</a>`:'';
      return `<article class="product-card"><div class="product-visual" data-missing="${missing}">${visual}</div><div class="product-card-body"><b>${card.name}</b><span>${card.status}</span><small>${card.note||ref?.note||'当前选项识别卡'}</small>${link}</div></article>`;
    }).join('');
    $$('.product-visual img').forEach(img=>img.addEventListener('error',()=>{img.parentElement.dataset.missing='true';}));
  }
  function renderAccessories(c){
    $('#accessory-grid').innerHTML=Object.entries(accessories).map(([k,a])=>{const checked=accessoryActive(c,k),forced=['boot','usbboot','front','rearfan','sidefans','drivefans','slim','hba','psucable','dualsfx','dualsync','dualcables'].includes(k),price=k==='dualsfx'?c.secondaryPsu.price:a.price,name=k==='dualsfx'?`第二颗背板电源：${c.secondaryPsu.name}`:a.name;return `<label class="accessory-item"><input type="checkbox" data-accessory="${k}" ${checked?'checked':''} ${forced?'disabled':''}><b>${name}</b><strong>${range(price)}</strong><p>${a.why}</p><small>${forced?'由当前配置自动决定':'可选配件'}</small></label>`;}).join('');
    $$('[data-accessory]').forEach(el=>el.addEventListener('change',()=>{el.checked?state.selectedAccessories.add(el.dataset.accessory):state.selectedAccessories.delete(el.dataset.accessory);render();}));
  }
  function renderPrice(c){
    const m2Role=c.boot==='m2'?'#1 = TrueNAS Boot；#2 = 单盘 / 待用':'两槽同时使用，建议作 ZFS 镜像 fast pool';
    const rows=[
      ['机箱','JONSBO N6','已购','你的成交 ¥629','官方产品页未列 MSRP','未知','¥629','成交平台未注明；不得冒充京东/拼多多现价'],
      ['主板','ASUS W680M-ACE SE','已购','你的成交 ¥2,799','ASUS 官方页未列 MSRP','未知','¥2,799','精确 SKU、附件、BMC 与保修状态以订单/实物为准'],
      ['CPU','Intel i5-14500','已购','你的成交 ¥1,380','Intel 建议客户价：Tray US$232 / Box US$242','未知','¥1,380','建议客户价不是中国零售 MSRP；散片/盒装与保修需区分'],
      ['电源',c.psu.name,'待购',range(c.psu.price),c.psu.official,'未知',fmt(c.psu.mid),c.psu.source],
      ['CPU 散热',c.cooler.name,'待购',range(c.cooler.price),'厂商中国区页面未取得统一 MSRP','未知',fmt(c.cooler.mid),c.cooler.note],
      ['内存',c.ram.name,'待购',`${range(c.ram.price)} · ${c.ram.priceQuality}`,'同容量/规格因品牌与颗粒不同，无统一 MSRP','未知',fmt(c.ram.mid),c.ram.note],
      ['M.2 SSD','Samsung 980 PRO ×2','已有','购入价未提供','历史型号；现行官网价不可直接比较','未知','¥0',m2Role],
      ['数据盘',`24TB Exos X24 / 同级 CMR ×${c.disks}`,'待购',`每块 ¥4,200–¥4,950`,'企业盘因地区、接口与保修无统一官网零售价','未知',fmt(4500*c.disks),'滑杆盘数已计入完整配置；当前阶段 1 盘预算另列'],
      ['未来 GPU',c.gpu.name,c.gpu.tgp?'未来':'暂缓',range(c.gpu.price),c.gpu.official,'未知',c.gpu.tgp?fmt(c.gpu.mid):'¥0',c.gpu.tgp?'不计入当前待购总价；消费卡价格必须按具体 SKU 重查':'按需后装']
    ];
    Object.entries(accessories).forEach(([k,a])=>{if(accessoryActive(c,k)){const price=k==='dualsfx'?c.secondaryPsu.price:a.price,mid=k==='dualsfx'?c.secondaryPsu.mid:a.mid,name=k==='dualsfx'?`第二颗背板电源：${c.secondaryPsu.name}`:a.name,status=k==='hardware'?'随箱核对':'待购';rows.push(['配件',name,status,range(price),k==='hardware'?'N6 手册配件清单':'未发现统一官方价','未知',fmt(mid),a.why]);}});
    $('#price-table').innerHTML=rows.map(r=>`<tr>${r.map(x=>`<td>${x}</td>`).join('')}</tr>`).join('');
    const stageConfig={...c,disks:1,hbaMode:c.hbaMode==='always'?'always':'auto'},stage=priceModel(stageConfig,false,1),remain=priceModel(c,false,c.disks),future=priceModel(c,true,c.disks);$('#stage-total').textContent=fmt(stage);$('#selected-total-label').textContent=`所选 ${c.disks} 盘待购（不含未来 GPU）`;$('#remaining-total').textContent=fmt(remain);$('#grand-total-label').textContent='所选配置整机（不含未来 GPU）';$('#grand-total').textContent=fmt(fixedCost+remain);$('#future-total').textContent=fmt(fixedCost+future);renderAccessories(c);
  }
  function renderChecklist(c){
    const bootInstall=c.boot==='bay'?'把 2.5″ SATA 启动 SSD 装入第 9 托架，再装数据 HDD。':c.boot==='m2'?'确认 980 PRO #1 已指定为 TrueNAS Boot；#2 暂作单盘或留待后续。':'把外置 USB 启动 SSD 固定在机箱后方，整理短线并加防误拔标记。';
    const bootPool=c.boot==='bay'?['小 SATA SSD 独占 TrueNAS 启动池。','两块 980 PRO 建镜像 fast pool：应用、缩略图、数据库与索引。']:c.boot==='m2'?['980 PRO #1 被 TrueNAS 启动池独占，不能同时放应用数据。','980 PRO #2 只能单盘使用或暂时留空；不要把它描述成镜像。']:['外置 USB SSD 独占 TrueNAS 启动池，并固定线材。','两块 980 PRO 建镜像 fast pool：应用、缩略图、数据库与索引。'];
    $('#install-order-list').innerHTML=['主板外安装 CPU、内存、两块 M.2 与散热器。','先装 PSU，并先穿 EPS 8-pin；ATX 路线这里最紧。','装主板，再按当前拓扑安装可用的风扇 / 冷排并接背板供电和数据线。',bootInstall,'GPU 与 HBA 后装；搬家时建议拆下重型消费卡单独运输。'].map(x=>`<li>${x}</li>`).join('');
    $('#pool-plan-list').innerHTML=[...bootPool,'单块 24TB 先建单盘数据 VDEV，但重要数据必须另有一份。','第二块 ≥24TB 到位后用 Attach 转为镜像；容量取较小盘。','长期按镜像对扩容；若用第 9 托架作 SATA Boot，数据 HDD 上限就是 8。'].map(x=>`<li>${x}</li>`).join('');
  }
  function render(){
    const diskInput=$('#disk-range'),bootMode=$('#boot-select').value,frontToggle=$('#front-fans'),frontSfx=frontSfxSelected();
    diskInput.max=bootMode==='bay'?String(limits.trays-1):String(limits.trays);
    if(+diskInput.value>+diskInput.max)diskInput.value=diskInput.max;
    const dual=$('#psu-position').value==='dual',customGpu=$('#gpu-select').value==='custom';
    $('#secondary-psu-field').classList.toggle('is-hidden',!dual);$('#dual-start-field').classList.toggle('is-hidden',!dual);$('#gpu-custom-fields').classList.toggle('is-hidden',!customGpu);
    if(coolers[$('#cooler-select').value].fit==='front240'){frontToggle.checked=true;frontToggle.disabled=true;}else frontToggle.disabled=false;
    const c=readConfig(),preserve=$('#preserve-hba'),rearToggle=$('#rear-fan'),rearAvailable=rearFanAvailable(c);if(hasHba(c)){preserve.checked=true;preserve.disabled=true;c.preserve=true;}else preserve.disabled=false;
    if(!rearAvailable){rearToggle.checked=false;rearToggle.disabled=true;c.rear=false;}
    else if(c.coolerKey==='cooler.aio-120-experimental'){rearToggle.checked=true;rearToggle.disabled=true;c.rear=true;}
    else rearToggle.disabled=false;
    // Manual §14 puts the drive-area 120×2 on the left bracket, and §8.1 removes that
    // bracket for the bottom PSU rack — so the two cannot both be installed.
    const driveToggle=$('#drive-fans'),leftBracketGone=c.psuPosition==='bottom'||c.psuPosition==='dual';
    if(leftBracketGone){driveToggle.checked=false;driveToggle.disabled=true;c.drive=false;}else driveToggle.disabled=false;
    $('#drive-fans-label').textContent=leftBracketGone?'左侧风扇架已被下置电源占用（手册 §8.1）· 盘区 120×2 不可装':'2×120mm 盘区风扇已安装（左侧位 · 需另购）';
    $('#front-fans-label').textContent=frontSfx?(c.cooler.fit==='front240'?'前置 SFX + 240 冷排 · 保守互斥':frontToggle.checked?'请求完整前风扇 · 与 SFX 待实测/不计风量':'完整前风扇（勾选可查看冲突）'):c.cooler.fit==='front240'?'前置 240 冷排自带 2×120 风扇':'2×140mm 前进风';
    $('#rear-fan-label').textContent=!rearAvailable?'后上 ATX 占位 · 后 120 不可装':c.coolerKey==='cooler.aio-120-experimental'?'后置 120 冷排风扇占位':'1×120mm 后排风';
    $('#disk-output').textContent=c.disks+' 块'+(c.boot==='bay'?' + 第9托架启动盘':'');diskInput.title=c.boot==='bay'?'第 9 托架已给 SATA 启动 SSD，数据盘最多 8 块':'启动盘不占托架，数据盘最多 9 块';$('#ambient-output').textContent=c.ambient+'°C';
    const ramNote=$('#ram-compat-note'),ramFlags=[];if(c.ram.modules===1)ramFlags.push('单通道');if(c.ram.ecc)ramFlags.push('ECC UDIMM');if(c.ram.qvl)ramFlags.push('板上 QVL 有本料号');else if(c.ram.ecc)ramFlags.push('ECC 料号需再核 QVL');if(c.ram.xmp)ramFlags.push('XMP 超频 · 不保证标称频率');ramNote.dataset.level=ramFlags.length?'warn':'ok';ramNote.textContent=`${c.ram.name}${c.ram.mpn?`（${c.ram.mpn}）`:''}：${c.ram.capacity}GB，${c.ram.modules} 条，约 ${c.ram.height}mm 高。W680M-ACE SE 仅支持 DDR5 Unbuffered DIMM（ECC / Non-ECC），不兼容 DDR4、RDIMM、LRDIMM；i5-14500 官方 DDR5 基线 4800 MT/s，平台容量上限 192GB。${ramFlags.length?' 当前注意：'+ramFlags.join('；')+'。':''}`;
    const p=powerModel(c),a=acousticModel(c,p),fit=fitModel(c);
    // Evaluate first, then draw. The V2 engine used to run in `LAB.afterRender`,
    // i.e. after the KPI strip had already been written from V1 heuristics; now the
    // geometry, the collisions and the temperatures all come from this one call.
    const env=thermalEnv(c,p);
    const ev=LAB.evaluate(env);
    lastEval=ev;lastConfig=c;
    renderOverview(c,p,a,fit,ev);renderThermal(c,p,a,ev);renderWiring(c);renderGpu(c);renderPrice(c);renderProducts(c);renderChecklist(c);
    LAB.afterRender(ev,env);
  }
  const referencePages={
    spec:{src:'assets/reference/n6-p2.jpg',alt:'JONSBO N6 官方手册第2页规格表',caption:'证明 305×353×318mm 外形、ATX/SFX 长度上限，以及 65–160mm / 275–320mm 发布范围；不提供两个端点对应的内部拓扑。'},
    parts:{src:'assets/reference/n6-p-04.jpg',alt:'JONSBO N6 官方手册配件清单页',caption:'手册列出螺丝、10 个垫片、5 根扎带与安装支架；没有列出随箱风扇，因此 ¥629 SKU 的风扇必须以开箱实物为准。'},
    frontsfx:{src:'assets/reference/n6-p10.jpg',alt:'JONSBO N6 官方手册前置SFX安装页',caption:'证明前置 SFX 安装方式；页面没有提供它与完整前风扇或 240 冷排的共存尺寸。'},
    bottomsfx:{src:'assets/reference/n6-p11.jpg',alt:'JONSBO N6 官方手册下置SFX安装页',caption:'证明 SFX 可装后下位，并需要按步骤处理侧支架；剩余侧风扇净空没有毫米值。'},
    dual:{src:'assets/reference/n6-p12.jpg',alt:'JONSBO N6 官方手册双电源安装页',caption:'证明 ATX+SFX 与 SFX+SFX 的机械安装路线；不代表热备冗余，也没有给 PS_ON 同步电路。'},
    cables:{src:'assets/reference/n6-p14.jpg',alt:'JONSBO N6 官方手册理线区域页',caption:'只证明厂家建议的走线区域；插头弯折半径、定制线长度与满配拥挤程度仍需实装。'},
    backplane:{src:'assets/reference/n6-p16.jpg',alt:'JONSBO N6 官方手册背板供电页',caption:'背板有 2 个 SATA Power 与 2 个 Molex 供电口；手册要求四个口各用一条独立 PSU 线束。'},
    fans:{src:'assets/reference/n6-p17.jpg',alt:'JONSBO N6 官方手册风扇和240冷排安装位页',caption:'证明风扇与前置 240 冷排“支持安装位”；不证明随机附送风扇，也不提供前置 SFX 共存矩阵。'},
    trays:{src:'assets/reference/n6-p19.jpg',alt:'JONSBO N6 官方手册共享硬盘托架页',caption:'每个托架为 2.5/3.5 英寸二选一；第 9 托架装 SATA Boot 时，数据 HDD 上限为 8 块。'}
  };
  function renderReference(){const item=referencePages[$('#reference-select').value]||referencePages.spec;$('#reference-image').src=item.src;$('#reference-image').alt=item.alt;$('#reference-caption').textContent=item.caption;}
  $$('.lab-tab').forEach(btn=>btn.addEventListener('click',()=>{$$('.lab-tab').forEach(x=>x.setAttribute('aria-selected',String(x===btn)));$$('.lab-panel').forEach(p=>p.classList.toggle('is-hidden',p.dataset.panel!==btn.dataset.tab));}));
  $$('[data-case-view-target]').forEach(btn=>btn.addEventListener('click',()=>{
    const target=btn.dataset.caseViewTarget;
    $$('[data-case-view-target]').forEach(x=>x.setAttribute('aria-pressed',String(x===btn)));
    $$('[data-case-view]').forEach(x=>x.classList.toggle('is-hidden',x.dataset.caseView!==target));
  }));
  const bindFieldMode=(attr,key)=>$$(`[data-${attr}]`).forEach(btn=>btn.addEventListener('click',()=>{
    heatState[key]=btn.dataset[attr.replace(/-([a-z])/g,(_,ch)=>ch.toUpperCase())];
    $$(`[data-${attr}]`).forEach(x=>x.setAttribute('aria-pressed',String(x===btn)));
    if(lastEval)renderThermalField(lastConfig,lastEval);
  }));
  bindFieldMode('heat-bound','bound');
  bindFieldMode('heat-plane','plane');
  ['psu-select','psu-position','secondary-psu-select','dual-start-select','cooler-select','gpu-select','gpu-custom-name','gpu-custom-length','gpu-custom-slots','gpu-custom-tgp','gpu-custom-vram','gpu-custom-price','ram-select','disk-range','boot-select','nvme-select','hba-select','fan-select','ambient-range','workload-select','pl-select','front-fans','rear-fan','drive-fans','side-fans','preserve-hba'].forEach(id=>$('#'+id).addEventListener('input',()=>render()));
  $('#reference-select').addEventListener('input',renderReference);$('#spatial-reset').addEventListener('click',resetSpatialView);renderReference();

  // Routes are off by default: they cross the whole case, and the mechanical view
  // has to stay readable for someone checking clearances instead of cables.
  const routeToggle=$('#spatial-routes');
  if(routeToggle)routeToggle.addEventListener('click',()=>{
    spatialState.showRoutes=!spatialState.showRoutes;
    routeToggle.setAttribute('aria-pressed',String(spatialState.showRoutes));
    if(!spatialState.showRoutes)spatialState.routeFocus=null;
    if(spatialState.config)renderSpatial(spatialState.config);
  });
  // The routing table owns selection; the view only follows it, and turns routes on
  // so a click there never looks like it did nothing.
  document.addEventListener('n6:route-focus',event=>{
    spatialState.routeFocus=(event.detail&&event.detail.id)||null;
    if(spatialState.routeFocus&&!spatialState.showRoutes){
      spatialState.showRoutes=true;
      if(routeToggle)routeToggle.setAttribute('aria-pressed','true');
    }
    if(spatialState.config)renderSpatial(spatialState.config);
  });

  /**
   * Airflow inputs for the V2 air-balance model. The left-side 120×2 mounts are the
   * drive-area pair, so they ride on the bracket the bottom PSU rack removes.
   */
  function thermalEnv(c,p){
    const lower=c.psuPosition==='bottom'||c.psuPosition==='dual';
    return {
      ambientC:c.ambient,
      fanMode:c.fan,
      fans:{
        front:c.front?{size:140,count:2}:null,
        rear:c.rear?{size:120,count:1}:null,
        left:c.drive?{size:120,count:2}:null,
        right:c.side?{size:120,count:2}:null
      },
      upperWatts:p.base+p.cpu+p.gpu+p.hba,
      psuDcWatts:lower?(c.psuPosition==='dual'?p.driveDc:p.mainDc):0,
      workload:c.workload==='idle'?'idle':'work',
      // Per-part dissipation, so component temperatures rest on this same split
      // instead of a second guess made inside the thermal model.
      loads:{cpuW:p.cpu,gpuW:p.gpu,hbaW:p.hba,psuDcW:p.mainDc},
      reserveHbaSlot:Boolean(c.preserve),
      gpuOverride:c.gpuKey==='custom'
        ? {name:c.gpu.name,lengthMm:c.gpu.length,slots:c.gpu.slots,workstation:false}
        : null
    };
  }
  window.__N6_LAB_API__ = { readConfig, render, root, $ };
  installSpatialInteraction();
  render();
})();
