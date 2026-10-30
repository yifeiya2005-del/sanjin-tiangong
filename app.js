const loadingBar = document.getElementById('loading-bar');
        const loadingStatus = document.getElementById('loading-status');
        const loadingOverlay = document.getElementById('loading-overlay');

        function updateProgress(pct) {
            if (loadingBar) loadingBar.style.width = pct + '%';
            if (loadingStatus) {
                if (pct < 100) {
                    loadingStatus.textContent = '已研墨 ' + pct + '%';
                } else {
                    loadingStatus.textContent = '画卷已成 · 展开入画';
                }
            }
        }

        function finishLoading() {
            updateProgress(100);
            setTimeout(() => {
                if (loadingOverlay) loadingOverlay.classList.add('fade-out');
            }, 350);
        }

        function initApp() {
            // 绑定真实朱砂印章资产
        if (typeof ELEMENT_ASSETS !== 'undefined' && ELEMENT_ASSETS.hongyin) {
            document.documentElement.style.setProperty('--seal-bg', `url("${ELEMENT_ASSETS.hongyin}")`);
        }

        // 1. 初始化场景与渲染器（移动端采用电脑原版画布 1:1 全局等比 Scale-to-Fit 矩阵缩放，零换行、零变形）
        const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        let isPortraitRotated = false;
        let mobileZoomScale = 1.0;
        let viewW = window.innerWidth;
        let viewH = window.innerHeight;

        function updateViewportMetrics() {
            const rawW = (window.visualViewport && window.visualViewport.width) ? window.visualViewport.width : window.innerWidth;
            const rawH = (window.visualViewport && window.visualViewport.height) ? window.visualViewport.height : window.innerHeight;
            if (rawH > rawW && rawW <= 920) {
                // 手机竖屏：此时浏览器底层 1vh = rawH / 100。
                // 我们将 body 的逻辑高度设为 rawH (等于 100vh)，逻辑宽度设为 rawH * (rawH / rawW)，
                // 再将整个 body 旋转 90° 后直接等比缩小 scale = rawW / rawH，使内部所有 vh 元素与电脑端 100% 像素级同比例！
                isPortraitRotated = true;
                document.documentElement.classList.add('mobile-portrait-rotated');
                mobileZoomScale = rawW / rawH;
                viewH = rawH;
                viewW = Math.round(rawH * (rawH / rawW));
                document.documentElement.style.setProperty('--m-scale', mobileZoomScale.toFixed(5));
                document.documentElement.style.setProperty('--m-width', `${viewW}px`);
                document.documentElement.style.setProperty('--m-height', `${viewH}px`);
                document.documentElement.style.setProperty('--m-left', `${rawW}px`);
            } else {
                isPortraitRotated = false;
                document.documentElement.classList.remove('mobile-portrait-rotated');
                mobileZoomScale = 1.0;
                viewW = rawW;
                viewH = rawH;
                document.documentElement.style.removeProperty('--m-scale');
                document.documentElement.style.removeProperty('--m-width');
                document.documentElement.style.removeProperty('--m-height');
                document.documentElement.style.removeProperty('--m-left');
            }
        }
        updateViewportMetrics();

        // 将物理屏幕坐标 (clientX, clientY) 自动映射为当前长卷逻辑横屏坐标 (x, y)
        function mapClientToLogical(cx, cy) {
            if (isPortraitRotated) {
                const rawW = (window.visualViewport && window.visualViewport.width) ? window.visualViewport.width : window.innerWidth;
                return {
                    x: cy / mobileZoomScale,
                    y: (rawW - cx) / mobileZoomScale
                };
            }
            return { x: cx, y: cy };
        }

        const canvas = document.getElementById('webgl-canvas');
        const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(viewW, viewH);
        renderer.setClearColor(0xf2ebd9, 1.0); // 熟宣纸暖底色

        const scene = new THREE.Scene();

        // 2. 小红书关键参数：FOV 锁死 26°（中长焦压平纵深，静止为工笔古画，移动流露视差）
        const camera = new THREE.PerspectiveCamera(26, viewW / viewH, 1, 450);
        
        // 默认黄金观赏位：主楼清晰显现、山水与树木完整入画
        const cameraOrigin = { x: -35.0, y: 0.0, z: 125.0 };
        const cameraTarget = { x: -35.0, y: 0.0, z: 125.0 };
        camera.position.set(cameraOrigin.x, cameraOrigin.y, cameraOrigin.z);

        const textureLoader = new THREE.TextureLoader();

        // 3. 着色器系统：底层环境光遮蔽 AO 加深 + 景深消融 + 四周柔性消融
        const vertexShader = `
            varying vec2 vUv;
            varying float vDistance;
            void main() {
                vUv = uv;
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                vDistance = -mvPosition.z;
                gl_Position = projectionMatrix * mvPosition;
            }
        `;

        const fragmentShader = `
            uniform sampler2D uMap;
            uniform vec3 uBgColor;        // 熟宣纸底色 #f2ebd9 (0.949, 0.922, 0.851)
            uniform float uFarNear;       // 远景开始溶解距离
            uniform float uFarFar;        // 远景最大溶解距离
            uniform float uMaxFade;       // 远景溶纸上限 (0.7)
            uniform float uNearFadeMin;   // 近景穿透消隐下限
            uniform float uNearFadeMax;   // 近景穿透消隐上限
            uniform vec2 uEdgeFeather;    // 四周边缘柔性融入系数
            uniform float uAOFactor;      // 底部环境光遮蔽加深强度
            uniform float uAORange;       // 底部遮蔽作用高度范围
            uniform float uAlphaTest;     // 透明通道切除阈值
            uniform float uEdgeAlpha;     // 动态边缘渐变系数 (流云淡入淡出)

            varying vec2 vUv;
            varying float vDistance;

            void main() {
                vec4 texColor = texture2D(uMap, vUv);

                // 四周边缘柔性羽化消融
                float edgeX = smoothstep(0.0, uEdgeFeather.x, min(vUv.x, 1.0 - vUv.x));
                float edgeY = smoothstep(0.0, uEdgeFeather.y, min(vUv.y, 1.0 - vUv.y));
                float edgeFactor = edgeX * edgeY;

                // 底部环境光自阴影 (方案 C 强化版)
                float aoRamp = smoothstep(0.0, uAORange, vUv.y);
                float aoDim = mix(1.0 - uAOFactor, 1.0, aoRamp);
                vec3 shadedRGB = texColor.rgb * aoDim;

                // 远景水墨渗化溶纸
                float farFade = smoothstep(uFarNear, uFarFar, vDistance) * uMaxFade;
                float lum = dot(shadedRGB, vec3(0.299, 0.587, 0.114));
                vec3 desatColor = mix(shadedRGB, vec3(lum), farFade * 0.5);
                float paperFade = max(0.18, farFade);
                vec3 dissolvedColor = mix(desatColor, uBgColor, paperFade);

                vec3 finalColor = mix(uBgColor, dissolvedColor, edgeFactor);

                // 方案 1：全局宣纸温润暖调色温锁死 (全域高光与浅色调恒定锚定于 #f2ebd9 熟宣古色，绝不发白)
                finalColor = mix(finalColor, finalColor * uBgColor * 1.08, 0.45);
                finalColor = mix(finalColor, uBgColor, 0.08);

                // 近距镜头穿透消隐
                float nearOpacity = smoothstep(uNearFadeMin, uNearFadeMax, vDistance);

                float finalAlpha = texColor.a * nearOpacity * edgeFactor * uEdgeAlpha;
                if (finalAlpha < uAlphaTest) discard;

                gl_FragColor = vec4(finalColor, finalAlpha);
            }
        `;

        const paperColorVec3 = new THREE.Vector3(0.949, 0.922, 0.851);

        
        // 3.1 核心建筑专用：由底向顶拔地浮现着色器 (推进时由基座向上升起显现)
        const emergingFragmentShader = `
            uniform sampler2D uMap;
            uniform vec3 uBgColor;
            uniform float uFarNear;
            uniform float uFarFar;
            uniform float uMaxFade;
            uniform float uAlphaTest;
            uniform float uAppearProgress; // 0.0 (远景空旷) -> 1.0 (近景拔地封顶)
            uniform float uDepartAlpha;    // 1.0 (特写常驻) -> 0.0 (前行离场淡出)
            uniform vec2 uEdgeFeather;
            uniform float uAOFactor;
            uniform float uAORange;
            uniform float uEdgeAlpha;

            varying vec2 vUv;
            varying float vDistance;

            float hash(vec2 p) {
                return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
            }

            void main() {
                // 彻底杜绝初始远景下的底部马赛克噪点残留
                if (uAppearProgress <= 0.005) {
                    discard;
                }

                vec4 texColor = texture2D(uMap, vUv);

                float edgeX = smoothstep(0.0, uEdgeFeather.x, min(vUv.x, 1.0 - vUv.x));
                float edgeY = smoothstep(0.0, uEdgeFeather.y, min(vUv.y, 1.0 - vUv.y));
                float edgeFactor = edgeX * edgeY;

                // 底部 AO 阴影
                float aoRamp = smoothstep(0.0, uAORange, vUv.y);
                float aoDim = mix(1.0 - uAOFactor, 1.0, aoRamp);
                vec3 shadedRGB = texColor.rgb * aoDim;

                // 由底向顶生长门限：严格从 0.0 向上推进
                vec2 blockUv = floor(vUv * vec2(90.0, 70.0));
                float grain = (hash(blockUv) - 0.5) * 0.06;
                float threshold = uAppearProgress * 1.15;

                // 未生长的上方屋檐直接剔除
                if (vUv.y > threshold + grain) {
                    discard;
                }

                // 生长前锋过渡带：水墨由纸凝聚为实彩
                float growthEdge = smoothstep(threshold - 0.08, threshold + 0.01, vUv.y);

                float farFade = smoothstep(uFarNear, uFarFar, vDistance) * uMaxFade;
                float lum = dot(shadedRGB, vec3(0.299, 0.587, 0.114));
                vec3 desatColor = mix(shadedRGB, vec3(lum), max(farFade * 0.5, growthEdge * 0.5));
                float paperFade = max(0.18, max(farFade, growthEdge * 0.7));
                vec3 dissolvedColor = mix(desatColor, uBgColor, paperFade);
                vec3 finalColor = mix(uBgColor, dissolvedColor, edgeFactor);

                // 方案 1：全局宣纸温润暖调色温锁死 (全域高光与浅色调恒定锚定于 #f2ebd9 熟宣古色，绝不发白)
                finalColor = mix(finalColor, finalColor * uBgColor * 1.08, 0.45);
                finalColor = mix(finalColor, uBgColor, 0.08);

                float finalAlpha = texColor.a * (1.0 - growthEdge * 0.25) * edgeFactor * uDepartAlpha;
                if (finalAlpha < uAlphaTest) discard;

                gl_FragColor = vec4(finalColor, finalAlpha);
            }
        `;

        function createEmergingMaterial(dataUri, options = {}) {
            const texture = textureLoader.load(dataUri);
            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;

            return new THREE.ShaderMaterial({
                vertexShader: vertexShader,
                fragmentShader: emergingFragmentShader,
                uniforms: {
                    uMap: { value: texture },
                    uEdgeAlpha: { value: 1.0 },
                    uBgColor: { value: paperColorVec3 },
                    uFarNear: { value: options.farNear || 60.0 },
                    uFarFar: { value: options.farFar || 140.0 },
                    uMaxFade: { value: options.maxFade !== undefined ? options.maxFade : 0.15 },
                    uAppearProgress: { value: 0.0 },
                    uDepartAlpha: { value: 1.0 },
                    uEdgeFeather: { value: options.edgeFeather || new THREE.Vector2(0.015, 0.015) },
                    uAOFactor: { value: options.aoFactor !== undefined ? options.aoFactor : 0.0 },
                    uAORange: { value: options.aoRange !== undefined ? options.aoRange : 0.15 },
                    uAlphaTest: { value: 0.02 }
                },
                transparent: true,
                depthWrite: false,
                depthTest: true
            });
        }

        
        // 3.2 配景大苍松专用：由顶向下逐渐消融着色器 (推进时由树冠向下消解飘散至树根)
        const treeDissolvingFragmentShader = `
            uniform sampler2D uMap;
            uniform vec3 uBgColor;
            uniform float uFarNear;
            uniform float uFarFar;
            uniform float uMaxFade;
            uniform float uAlphaTest;
            uniform float uDissolveProgress; // 0.0 (远景完整) -> 1.0 (近景完全消融)
            uniform vec2 uEdgeFeather;
            uniform float uAOFactor;
            uniform float uAORange;
            uniform float uEdgeAlpha;

            varying vec2 vUv;
            varying float vDistance;

            float hash(vec2 p) {
                return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
            }

            void main() {
                // 完全消融后彻底清除
                if (uDissolveProgress >= 0.995) {
                    discard;
                }

                vec4 texColor = texture2D(uMap, vUv);

                float edgeX = smoothstep(0.0, uEdgeFeather.x, min(vUv.x, 1.0 - vUv.x));
                float edgeY = smoothstep(0.0, uEdgeFeather.y, min(vUv.y, 1.0 - vUv.y));
                float edgeFactor = edgeX * edgeY;

                // 底部 AO 阴影
                float aoRamp = smoothstep(0.0, uAORange, vUv.y);
                float aoDim = mix(1.0 - uAOFactor, 1.0, aoRamp);
                vec3 shadedRGB = texColor.rgb * aoDim;

                // 由顶向下消融门限：vUv.y 越高(树顶)越先消散
                vec2 blockUv = floor(vUv * vec2(80.0, 70.0));
                float grain = (hash(blockUv) - 0.5) * 0.08;
                float threshold = (1.05 - uDissolveProgress * 1.15) + grain;

                // 高于消融前锋的树冠直接飘散剔除
                if (vUv.y > threshold + 0.02) {
                    discard;
                }

                // 消融前锋边缘过渡带：松针墨色淡化，向熟宣纸底色消散
                float edgeFade = smoothstep(threshold - 0.08, threshold + 0.01, vUv.y);

                float farFade = smoothstep(uFarNear, uFarFar, vDistance) * uMaxFade;
                float lum = dot(shadedRGB, vec3(0.299, 0.587, 0.114));
                vec3 desatColor = mix(shadedRGB, vec3(lum), max(farFade * 0.5, edgeFade * 0.6));
                float paperFade = max(0.18, max(farFade, edgeFade * 0.85));
                vec3 dissolvedColor = mix(desatColor, uBgColor, paperFade);
                vec3 finalColor = mix(uBgColor, dissolvedColor, edgeFactor);

                // 方案 1：全局宣纸温润暖调色温锁死 (全域高光与浅色调恒定锚定于 #f2ebd9 熟宣古色，绝不发白)
                finalColor = mix(finalColor, finalColor * uBgColor * 1.08, 0.45);
                finalColor = mix(finalColor, uBgColor, 0.08);

                float finalAlpha = texColor.a * (1.0 - edgeFade * 0.4) * edgeFactor * uEdgeAlpha;
                if (finalAlpha < uAlphaTest) discard;

                gl_FragColor = vec4(finalColor, finalAlpha);
            }
        `;

        function createTreeDissolvingMaterial(dataUri, options = {}) {
            const texture = textureLoader.load(dataUri);
            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;

            return new THREE.ShaderMaterial({
                vertexShader: vertexShader,
                fragmentShader: treeDissolvingFragmentShader,
                uniforms: {
                    uMap: { value: texture },
                    uBgColor: { value: paperColorVec3 },
                    uFarNear: { value: options.farNear || 40.0 },
                    uFarFar: { value: options.farFar || 100.0 },
                    uMaxFade: { value: options.maxFade !== undefined ? options.maxFade : 0.0 },
                    uDissolveProgress: { value: 0.0 },
                    uEdgeFeather: { value: options.edgeFeather || new THREE.Vector2(0.06, 0.06) },
                    uAOFactor: { value: options.aoFactor !== undefined ? options.aoFactor : 0.48 },
                    uAORange: { value: options.aoRange !== undefined ? options.aoRange : 0.28 },
                    uAlphaTest: { value: 0.02 },
                    uEdgeAlpha: { value: options.edgeAlpha !== undefined ? options.edgeAlpha : 1.0 }
                },
                transparent: true,
                depthWrite: false,
                depthTest: true
            });
        }

        function createInkMaterial(dataUri, options = {}) {
            const texture = textureLoader.load(dataUri);
            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;

            const isTransparent = options.transparent !== false;

            return new THREE.ShaderMaterial({
                vertexShader: vertexShader,
                fragmentShader: fragmentShader,
                uniforms: {
                    uMap: { value: texture },
                    uBgColor: { value: paperColorVec3 },
                    uFarNear: { value: options.farNear || 80.0 },
                    uFarFar: { value: options.farFar || 200.0 },
                    uMaxFade: { value: options.maxFade !== undefined ? options.maxFade : 0.7 },
                    uNearFadeMin: { value: options.nearFadeMin !== undefined ? options.nearFadeMin : 0.0 },
                    uNearFadeMax: { value: options.nearFadeMax !== undefined ? options.nearFadeMax : 1.0 },
                    uEdgeFeather: { value: options.edgeFeather || new THREE.Vector2(0.01, 0.01) },
                    uAOFactor: { value: options.aoFactor !== undefined ? options.aoFactor : 0.0 },
                    uAORange: { value: options.aoRange !== undefined ? options.aoRange : 0.15 },
                    uAlphaTest: { value: isTransparent ? 0.02 : 0.0 },
                    uEdgeAlpha: { value: 1.0 }
                },
                transparent: isTransparent,
                depthWrite: false,
                depthTest: true
            });
        }

        // [背景长卷专属：水墨流体涟漪扩散着色器 (源自 Art-of-Ink 交互流体模拟思想)]
        const bgRippleArray = [];
        for (let r = 0; r < 8; r++) {
            bgRippleArray.push(new THREE.Vector4(0.0, 0.0, -100.0, 0.0));
        }

        const bgFragmentShader = `
            uniform sampler2D uMap;
            uniform vec3 uBgColor;
            uniform float uFarNear;
            uniform float uFarFar;
            uniform float uMaxFade;
            uniform vec2 uEdgeFeather;
            uniform vec4 uRipples[8]; // xy: UV坐标, z: 激发时间, w: 强度速度
            uniform float uTime;

            varying vec2 vUv;
            varying float vDistance;

            void main() {
                // 1. 水墨流体涟漪位移扩散 (基于二维毛细流体与波动衰减方程)
                vec2 rippleOffset = vec2(0.0);
                float totalWave = 0.0;

                for (int i = 0; i < 8; i++) {
                    if (uRipples[i].z <= 0.0) continue;
                    float age = uTime - uRipples[i].z;
                    if (age < 0.0 || age > 1.4) continue; // 消退时间收敛至 1.4 秒快速平息

                    vec2 diff = vUv - uRipples[i].xy;
                    diff.x *= 1.8; // 长卷画幅比例校正
                    float d = length(diff);

                    // 空间与时间双重阻尼：空间衰减系数翻倍至 24.0 (严格局限在鼠标指针微距小圈)，时间消退 1.2 秒
                    float wave = sin(d * 68.0 - age * 9.5);
                    float envelope = exp(-d * 24.0) * exp(-age * 2.8);
                    float disp = wave * envelope * uRipples[i].w * 0.0045;

                    rippleOffset += normalize(diff + vec2(0.0001)) * disp;
                    totalWave += abs(disp);
                }

                vec2 finalUv = clamp(vUv + rippleOffset, 0.0, 1.0);
                vec4 texColor = texture2D(uMap, finalUv);

                // 吸水微漫溢：纯连续线性映射，峰值严格处于 3% ~ 6% 之间，静止时 0 干扰
                float soakDarken = clamp(totalWave * 12.0, 0.0, 0.06);
                texColor.rgb = texColor.rgb * (1.0 - soakDarken);

                // 四周边缘柔性消隐
                float edgeX = smoothstep(0.0, uEdgeFeather.x, min(vUv.x, 1.0 - vUv.x));
                float edgeY = smoothstep(0.0, uEdgeFeather.y, min(vUv.y, 1.0 - vUv.y));
                float edgeFactor = edgeX * edgeY;

                // 远景水墨渗化溶纸与宣纸温润色温锁死 (方案 1)
                float farFade = smoothstep(uFarNear, uFarFar, vDistance) * uMaxFade;
                float paperFade = max(0.18, farFade);
                vec3 dissolvedColor = mix(texColor.rgb, uBgColor, paperFade);
                vec3 finalColor = mix(uBgColor, dissolvedColor, edgeFactor);

                finalColor = mix(finalColor, finalColor * uBgColor * 1.08, 0.45);
                finalColor = mix(finalColor, uBgColor, 0.08);

                gl_FragColor = vec4(finalColor, 1.0);
            }
        `;

        function createBackgroundMaterial(dataUri, options = {}) {
            const texture = textureLoader.load(dataUri);
            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;

            return new THREE.ShaderMaterial({
                vertexShader: vertexShader,
                fragmentShader: bgFragmentShader,
                uniforms: {
                    uMap: { value: texture },
                    uBgColor: { value: paperColorVec3 },
                    uFarNear: { value: options.farNear || 140.0 },
                    uFarFar: { value: options.farFar || 380.0 },
                    uMaxFade: { value: options.maxFade !== undefined ? options.maxFade : 0.35 },
                    uEdgeFeather: { value: options.edgeFeather || new THREE.Vector2(0.001, 0.001) },
                    uRipples: { value: bgRippleArray },
                    uTime: { value: 0.0 }
                },
                transparent: false,
                depthWrite: false,
                depthTest: true
            });
        }

        // 4. 多图层纵深深入排布（一号前殿 Z=-55，二号后阁 Z=-110，斜向前行穿越）

        // [层 1：全景宋代新背景长卷 (丰富背景 + 交互水墨流体扩散)] 置于 Z = -250
        const bgGeo = new THREE.PlaneGeometry(450, 250.0);
        const bgMat = createBackgroundMaterial(ELEMENT_ASSETS.panorama_background, {
            transparent: false,
            farNear: 140.0,
            farFar: 380.0,
            maxFade: 0.35,
            edgeFeather: new THREE.Vector2(0.001, 0.001)
        });
        const bgMesh = new THREE.Mesh(bgGeo, bgMat);
        bgMesh.position.set(0, 8.5, -250);
        scene.add(bgMesh);

        // 已删除补充的配景山与额外峰峦，仅留「丰富背景」完整长卷，彻底解决左侧穿帮与重叠冲突

        // [层 3：双组动态流云 (大群磅礴 + 小群灵动，非等比例对比)]
        const cloudsMat1 = createInkMaterial(ELEMENT_ASSETS.clouds, { farNear: 60.0, farFar: 200.0, maxFade: 0.25, edgeFeather: new THREE.Vector2(0.06, 0.06) });
        const cloudsMat2 = createInkMaterial(ELEMENT_ASSETS.clouds, { farNear: 60.0, farFar: 200.0, maxFade: 0.35, edgeFeather: new THREE.Vector2(0.06, 0.06) });
        
        // 大组云：尺寸放大一倍 (143.0 × 80.6)，Y 下移 5 个单位 (11.0 -> 6.0)
        const cloudsMesh1 = new THREE.Mesh(new THREE.PlaneGeometry(143.0, 80.6), cloudsMat1);
        cloudsMesh1.position.set(20.0, 6.0, -25);
        scene.add(cloudsMesh1);

        // 小组云：尺寸放大一倍 (90.0 × 50.8)，Y 下移 5 个单位 (19.5 -> 14.5)
        const cloudsMesh2 = new THREE.Mesh(new THREE.PlaneGeometry(90.0, 50.8), cloudsMat2);
        cloudsMesh2.position.set(-15.0, 14.5, -50);
        scene.add(cloudsMesh2);

        const cloudInstances = [
            { mesh: cloudsMesh1, mat: cloudsMat1, speed: 1.2, xMin: -130.0, xMax: 130.0, yBase: 6.0, phase: 0.0, opacity: 0.55 },
            { mesh: cloudsMesh2, mat: cloudsMat2, speed: 0.85 * 1.1, xMin: -110.0, xMax: 110.0, yBase: 14.5, phase: 2.5, opacity: 0.50 }
        ];

        // [层 4-A：中景一号核心主楼] 置于前庭 Z = -55.0 (X = -35.0)
        const buildingGeo = new THREE.PlaneGeometry(44, 35.7);
        const buildingMat = createEmergingMaterial(ELEMENT_ASSETS.building, {
            farNear: 70.0,
            farFar: 160.0,
            maxFade: 0.15,
            edgeFeather: new THREE.Vector2(0.015, 0.015),
            aoFactor: 0.42,
            aoRange: 0.22
        });
        const buildingMesh = new THREE.Mesh(buildingGeo, buildingMat);
        buildingMesh.position.set(-35.0, -2.5, -55.0);
        scene.add(buildingMesh);

        // [层 4-B：二号建筑背景与主体 (X = +35.0, Z = -110.0)]
        const bldg2Geo = new THREE.PlaneGeometry(46, 25.875); // 宽高比 2816:1584

        // 1. 背景 2：右侧悬空绝壁主峰，在现有基础上放大 1.3 倍 (1.3 * 1.3 = 1.69x)，保持 Y = -29.5 不变
        const bg2Mat = createInkMaterial(ELEMENT_ASSETS.building2_layer2 || ELEMENT_ASSETS.building2_bg, {
            farNear: 70.0,
            farFar: 180.0,
            maxFade: 0.15,
            edgeFeather: new THREE.Vector2(0.001, 0.001),
            aoFactor: 0.35,
            aoRange: 0.20
        });
        bg2Mat.uniforms.uEdgeAlpha.value = 0.0;
        const bg2Mesh = new THREE.Mesh(bldg2Geo, bg2Mat);
        bg2Mesh.position.set(48.0, -31.0, -120.0); // Y 再下降 6 (-25.0 -> -31.0)
        bg2Mesh.scale.set(1.69, 1.69, 1.0);        // 放大 1.3 倍 (1.3 * 1.3 = 1.69)
        bg2Mesh.renderOrder = 10;
        scene.add(bg2Mesh);

        // 2. 背景 1：左侧近崖峡谷山峦，在现有基础上放大 1.3 倍 (1.3 * 1.3 = 1.69x)，保持 Y = -17.5 不变
        const bg2Layer1Mat = createInkMaterial(ELEMENT_ASSETS.building2_layer1, {
            farNear: 70.0,
            farFar: 180.0,
            maxFade: 0.15,
            edgeFeather: new THREE.Vector2(0.001, 0.001),
            aoFactor: 0.35,
            aoRange: 0.20
        });
        bg2Layer1Mat.uniforms.uEdgeAlpha.value = 0.0;
        const bg2Layer1Mesh = new THREE.Mesh(bldg2Geo, bg2Layer1Mat);
        bg2Layer1Mesh.position.set(35.0, -12.5, -110.0); // Y 再下降 6 (-6.5 -> -12.5)
        bg2Layer1Mesh.scale.set(1.69, 1.69, 1.0);        // 放大 1.3 倍 (1.3 * 1.3 = 1.69)
        bg2Layer1Mesh.renderOrder = 12;
        scene.add(bg2Layer1Mesh);

        // 3. 二号建筑：置于两张背景之前 (renderOrder = 30)，推近时由底向上拔地浮现
        const building2Mat = createEmergingMaterial(ELEMENT_ASSETS.building2, {
            farNear: 70.0,
            farFar: 180.0,
            maxFade: 0.15,
            edgeFeather: new THREE.Vector2(0.001, 0.001),
            aoFactor: 0.35,
            aoRange: 0.20
        });
        const building2Mesh = new THREE.Mesh(bldg2Geo, building2Mat);
        building2Mesh.position.set(35.0, -2.5, -110.0); // 建筑位于原高度 Y = -2.5
        building2Mesh.renderOrder = 30;
        scene.add(building2Mesh);

        // [层 4-C：三号建筑与配景 (长卷终章高潮，X = 0.0, Z = -180.0)]
        const bldg3Geo = new THREE.PlaneGeometry(48, 26.46); // 宽高比 2848:1570

        // 1. 三号配景：推进过程中透明度逐渐升至 100%
        const bg3Mat = createInkMaterial(ELEMENT_ASSETS.building3_bg, {
            farNear: 70.0,
            farFar: 180.0,
            maxFade: 0.15,
            edgeFeather: new THREE.Vector2(0.001, 0.001),
            aoFactor: 0.35,
            aoRange: 0.20
        });
        bg3Mat.uniforms.uEdgeAlpha.value = 0.0;
        const bg3Mesh = new THREE.Mesh(bldg3Geo, bg3Mat);
        bg3Mesh.position.set(0.0, -2.5, -180.0);
        bg3Mesh.renderOrder = 50;
        scene.add(bg3Mesh);

        // 2. 三号建筑：拔地浮现封顶
        const building3Mat = createEmergingMaterial(ELEMENT_ASSETS.building3, {
            farNear: 70.0,
            farFar: 180.0,
            maxFade: 0.15,
            edgeFeather: new THREE.Vector2(0.001, 0.001),
            aoFactor: 0.35,
            aoRange: 0.20
        });
        const building3Mesh = new THREE.Mesh(bldg3Geo, building3Mat);
        building3Mesh.position.set(0.0, -2.5, -180.0);
        building3Mesh.renderOrder = 60;
        scene.add(building3Mesh);

        // 永乐宫三清殿构件内景：《朝元图》矿物重彩神品
        const chaoyuanUri = (typeof ELEMENT_ASSETS !== 'undefined' && ELEMENT_ASSETS.chaoyuantu) ? ELEMENT_ASSETS.chaoyuantu : '朝元图.jpg';

        // 《朝元图》时光复原透镜：光标圆形区域内色彩瞬间“复原”，呈现青绿重彩与沥粉贴金，边缘羽化过渡
        const muralLensVertexShader = `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `;

        const muralLensFragmentShader = `
            uniform sampler2D uMap;
            uniform vec2 uLensUv;
            uniform float uLensRadius;
            uniform float uLensFeather;
            uniform float uOpacity;
            uniform float uAspect;

            varying vec2 vUv;

            void main() {
                vec4 texColor = texture2D(uMap, vUv);

                // 计算到光标透镜中心的距离 (补偿几何宽高比 uAspect，确保透镜为完美正圆)
                vec2 diff = vUv - uLensUv;
                diff.x *= uAspect;
                float dist = length(diff);

                // 透镜权重：圆内为 1.0 (重彩复原)，圆外平滑过渡至 0.0 (古雅风化素宣墨色)
                float lensFactor = 1.0 - smoothstep(uLensRadius - uLensFeather, uLensRadius + uLensFeather, dist);

                // 基础状态：岁月风化、水墨斑驳、古画微褐墨韵基调
                float gray = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
                vec3 weatheredColor = vec3(gray * 0.94, gray * 0.88, gray * 0.76);

                // 透镜内部：色彩瞬间“复原”，呈现青绿重彩与琉璃沥粉贴金本色
                vec3 restoredColor = texColor.rgb * 1.15;

                // 混合复原色彩与风化古彩（边缘纯自然羽化过渡，无多余内圈或描边）
                vec3 finalColor = mix(weatheredColor, restoredColor, lensFactor);

                gl_FragColor = vec4(finalColor, texColor.a * uOpacity);
            }
        `;

        const muralTexture = textureLoader.load(chaoyuanUri);
        muralTexture.generateMipmaps = true;
        muralTexture.minFilter = THREE.LinearMipmapLinearFilter;
        muralTexture.magFilter = THREE.LinearFilter;

        const muralDetailMat = new THREE.ShaderMaterial({
            vertexShader: muralLensVertexShader,
            fragmentShader: muralLensFragmentShader,
            uniforms: {
                uMap: { value: muralTexture },
                uLensUv: { value: new THREE.Vector2(0.5, 0.5) },
                uLensRadius: { value: 0.13 },     // 缩小透镜彩色圈半径 (聚焦工笔细部，避免覆盖过广)
                uLensFeather: { value: 0.05 },    // 精致柔和羽化过渡
                uOpacity: { value: 0.0 },
                uAspect: { value: 14.2 / 10.4 }   // 补偿几何长宽比 (1.36538)
            },
            transparent: true,
            depthWrite: false,
            depthTest: true
        });

        // 殿心内景朝元图近景真迹切片：置于大殿门厅中央焦点，高渲染层级彻底避开建筑遮挡
        const muralDetailGeo = new THREE.PlaneGeometry(14.2, 10.4);
        const muralDetailMesh = new THREE.Mesh(muralDetailGeo, muralDetailMat);
        muralDetailMesh.position.set(0.0, -1.0, -170.0);
        muralDetailMesh.renderOrder = 80; // 高于建筑(60)与石狮(50)，彻底避开建筑遮挡
        scene.add(muralDetailMesh);

        // [层 5-A：景位 3 背景石头树 · 放大1.8倍并移至石狮子与3建筑后侧，向左外推并向下沉地平]
        const treeRockLeftUri = (typeof ELEMENT_ASSETS !== 'undefined' && ELEMENT_ASSETS.tree_rock_left) ? ELEMENT_ASSETS.tree_rock_left : '背景石头树left.png';
        const treeRockLeftGeo = new THREE.PlaneGeometry(28.21, 32.40); // 放大 1.8 倍 (15.67*1.8=28.21, 18.0*1.8=32.40)
        const treeRockLeftMat = createInkMaterial(treeRockLeftUri, {
            farNear: 60.0,
            farFar: 260.0,
            maxFade: 0.0,
            edgeFeather: new THREE.Vector2(0.001, 0.001)
        });
        treeRockLeftMat.uniforms.uEdgeAlpha.value = 0.0;
        const treeRockLeftMesh = new THREE.Mesh(treeRockLeftGeo, treeRockLeftMat);
        treeRockLeftMesh.position.set(-33.0, -6.1, -186.0); // 向左移至X=-33，向下移至Y=-6.1，后置Z=-186
        treeRockLeftMesh.renderOrder = 35;
        scene.add(treeRockLeftMesh);

        // [层 5-B：景位 3 背景石头树 · 放大1.8倍并移至石狮子与3建筑后侧，向右外推并向下沉地平]
        const treeRockRightUri = (typeof ELEMENT_ASSETS !== 'undefined' && ELEMENT_ASSETS.tree_rock_right) ? ELEMENT_ASSETS.tree_rock_right : '背景石头树right.png';
        const treeRockRightGeo = new THREE.PlaneGeometry(30.96, 29.70); // 放大 1.8 倍 (17.20*1.8=30.96, 16.5*1.8=29.70)
        const treeRockRightMat = createInkMaterial(treeRockRightUri, {
            farNear: 60.0,
            farFar: 260.0,
            maxFade: 0.0,
            edgeFeather: new THREE.Vector2(0.001, 0.001)
        });
        treeRockRightMat.uniforms.uEdgeAlpha.value = 0.0;
        const treeRockRightMesh = new THREE.Mesh(treeRockRightGeo, treeRockRightMat);
        treeRockRightMesh.position.set(32.0, -6.8, -186.0); // 向右移至X=+32，向下移至Y=-6.8，后置Z=-186
        treeRockRightMesh.renderOrder = 35;
        scene.add(treeRockRightMesh);

        // [层 5-C：景位 3 近景仙鹤 · 采用松树同款消融着色器 (推进时由顶向下水墨消融消失)]
        const bg3CraneUri = (typeof ELEMENT_ASSETS !== 'undefined' && ELEMENT_ASSETS.crane_tight) ? ELEMENT_ASSETS.crane_tight : (ELEMENT_ASSETS.bg3_crane || '抠图鸟.png');
        const bg3CraneGeo = new THREE.PlaneGeometry(16.47, 19.57); // 放大 1.3 倍 (12.67*1.3=16.47, 15.05*1.3=19.57)
        const bg3CraneMat = createTreeDissolvingMaterial(bg3CraneUri, {
            farNear: 60.0,
            farFar: 200.0,
            maxFade: 0.0,
            aoFactor: 0.0, // 仙鹤羽毛保持纯净仙韵无底部重暗
            aoRange: 0.0,
            edgeFeather: new THREE.Vector2(0.001, 0.001),
            edgeAlpha: 0.0
        });
        bg3CraneMat.uniforms.uEdgeAlpha.value = 0.0;
        bg3CraneMat.uniforms.uDissolveProgress.value = 0.0;
        const bg3CraneMesh = new THREE.Mesh(bg3CraneGeo, bg3CraneMat);
        bg3CraneMesh.position.set(-14.0, -9.8, -148.0); // X移动至-14，保持Y=-9.8不变
        bg3CraneMesh.renderOrder = 70; // 明确置于3背景石狮(renderOrder=50)与树木(35)前方
        scene.add(bg3CraneMesh);

        // [仙鹤灵韵流光发光层] 贴合仙鹤轮廓的温润微金光晕，柔和雅致、指引明晰不过度夸张
        const craneGlowGeo = new THREE.PlaneGeometry(17.5, 20.8);
        const craneGlowMat = new THREE.ShaderMaterial({
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform float uOpacity;
                varying vec2 vUv;
                void main() {
                    vec2 center = vec2(0.5, 0.5);
                    vec2 d = (vUv - center) * vec2(1.15, 0.96);
                    float dist = length(d);
                    float alpha = smoothstep(0.44, 0.12, dist);
                    vec3 glowColor = mix(vec3(0.96, 0.84, 0.48), vec3(0.85, 0.42, 0.20), dist * 1.2);
                    gl_FragColor = vec4(glowColor, alpha * uOpacity * 0.20);
                }
            `,
            uniforms: {
                uOpacity: { value: 0.0 }
            },
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: true
        });
        const craneGlowMesh = new THREE.Mesh(craneGlowGeo, craneGlowMat);
        craneGlowMesh.position.set(-12.0, -9.8, -148.05); // 光圈向右移动 2 个单位
        craneGlowMesh.renderOrder = 68;
        scene.add(craneGlowMesh);

        // [层 5-D：景位 3 右上天空三飞鸟编队 (拆分三鸟，头统一朝左，拉大初始X间距)]
        const skyBirdsConfig = [
            { name: '飞鸟一（领航雁）', uri: (typeof ELEMENT_ASSETS !== 'undefined' && ELEMENT_ASSETS.sky_bird_1) ? ELEMENT_ASSETS.sky_bird_1 : 'bird_flock_1.png', w: 3.82, h: 3.5,  x: 20.2, y: 10.0, z: -142.0, speed: 2.3, phase: 0.0 },
            { name: '飞鸟二（中行雁）', uri: (typeof ELEMENT_ASSETS !== 'undefined' && ELEMENT_ASSETS.sky_bird_2) ? ELEMENT_ASSETS.sky_bird_2 : 'bird_flock_2.png', w: 3.53, h: 2.4,  x: 14.5, y: 11.5, z: -146.0, speed: 2.2, phase: 1.8 },
            { name: '飞鸟三（随行雁）', uri: (typeof ELEMENT_ASSETS !== 'undefined' && ELEMENT_ASSETS.sky_bird_3) ? ELEMENT_ASSETS.sky_bird_3 : 'bird_flock_3.png', w: 2.68, h: 2.0,  x: 26.5, y:  9.4, z: -150.0, speed: 2.1, phase: 3.4 }
        ];
        const skyBirdMeshes = [];
        const skyBirdMats = [];
        skyBirdsConfig.forEach((cfg) => {
            const geo = new THREE.PlaneGeometry(cfg.w, cfg.h);
            const mat = createInkMaterial(cfg.uri, {
                farNear: 60.0,
                farFar: 220.0,
                maxFade: 0.0,
                edgeFeather: new THREE.Vector2(0.001, 0.001)
            });
            mat.uniforms.uEdgeAlpha.value = 0.0;
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(cfg.x, cfg.y, cfg.z);
            mesh.renderOrder = 45;
            scene.add(mesh);
            skyBirdMeshes.push({ mesh, cfg });
            skyBirdMats.push(mat);
        });

        // [层 6：中近景右侧副树] 陪伴二号建筑前方 Z = -80
        const treeRightGeo = new THREE.PlaneGeometry(28.08, 23.71); // 放大 1.2 倍 (23.4*1.2=28.08, 19.76*1.2=23.71)
        const treeRightMat = createInkMaterial(ELEMENT_ASSETS.tree_right, {
            farNear: 40.0,
            farFar: 140.0,
            maxFade: 0.0,
            nearFadeMin: 15.0,
            nearFadeMax: 45.0,
            edgeFeather: new THREE.Vector2(0.06, 0.06),
            aoFactor: 0.40,
            aoRange: 0.25
        });
        const treeRightMesh = new THREE.Mesh(treeRightGeo, treeRightMat);
        treeRightMesh.position.set(6.0, -22.52, -80); // 底部根基固定在 Y=-34.38 不动，向上延展生长
        scene.add(treeRightMesh);

        // [层 6-B：右侧后置副树 (左侧大苍松底图水平镜像翻转，再放大 1.08 倍，置于右树后侧 Z = -92)]
        const treeRightBackGeo = new THREE.PlaneGeometry(44.17, 36.30); // 放大 1.08 倍 (40.90*1.08=44.17, 33.61*1.08=36.30)
        // 水平镜像翻转 UV 纹理坐标
        const uvArr = treeRightBackGeo.attributes.uv.array;
        for (let i = 0; i < uvArr.length; i += 2) {
            uvArr[i] = 1.0 - uvArr[i];
        }
        treeRightBackGeo.attributes.uv.needsUpdate = true;

        const treeRightBackMat = createInkMaterial(ELEMENT_ASSETS.tree, {
            farNear: 40.0,
            farFar: 150.0,
            maxFade: 0.12,
            edgeFeather: new THREE.Vector2(0.06, 0.06),
            aoFactor: 0.35,
            aoRange: 0.22
        });
        const treeRightBackMesh = new THREE.Mesh(treeRightBackGeo, treeRightBackMat);
        treeRightBackMesh.position.set(17.0, -20.3, -92.0); // 上移 1.5 单位 (-21.8 -> -20.3)，后侧错落掩映
        scene.add(treeRightBackMesh);

        // [层 7：近景穿透主树 (大苍松)] Z = +5.0 (伴随一号建筑前庭)
        const treeGeo = new THREE.PlaneGeometry(36.4, 29.9); // 放大 1.3 倍 (28*1.3=36.4, 23*1.3=29.9)
        const treeMat = createTreeDissolvingMaterial(ELEMENT_ASSETS.tree, {
            farNear: 40.0,
            farFar: 100.0,
            maxFade: 0.0,
            edgeFeather: new THREE.Vector2(0.06, 0.06),
            aoFactor: 0.48,
            aoRange: 0.28
        });
        const treeMesh = new THREE.Mesh(treeGeo, treeMat);
        treeMesh.position.set(-48.0, -6.0, 5.0); // 上移 2 个单位 (-8.0 -> -6.0)
        treeMesh.renderOrder = 72;
        scene.add(treeMesh);

        // [苍松灵韵流光发光层] 尺寸 42×46，峰值强度 0.28，上移3、左移2 (X=-50.5, Y=-5.8)
        const treeGlowGeo = new THREE.PlaneGeometry(42.0, 46.0);
        const treeGlowMat = new THREE.ShaderMaterial({
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform float uOpacity;
                varying vec2 vUv;
                void main() {
                    vec2 center = vec2(0.52, 0.48);
                    vec2 d = (vUv - center) * vec2(1.02, 0.96);
                    float dist = length(d);
                    float outerHalo = smoothstep(0.49, 0.08, dist);
                    float innerCore = smoothstep(0.28, 0.0, dist);
                    vec3 glowColor = mix(vec3(1.0, 0.85, 0.36), vec3(0.86, 0.34, 0.12), dist * 1.15);
                    float finalAlpha = (outerHalo * 0.18 + innerCore * 0.10) * uOpacity;
                    gl_FragColor = vec4(glowColor, finalAlpha);
                }
            `,
            uniforms: {
                uOpacity: { value: 0.0 }
            },
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: true
        });
        const treeGlowMesh = new THREE.Mesh(treeGlowGeo, treeGlowMat);
        treeGlowMesh.position.set(-50.5, -5.8, 4.92);
        treeGlowMesh.renderOrder = 71;
        scene.add(treeGlowMesh);

        // [层 8：灵韵流金萤火 (35 枚慢速漫游发光光团：30枚15~30px + 5枚32px，速度减缓至0.8倍，仅在景位 2->3 涌现并在 3 中常驻)]
        const fireflyCount = 35; // 30 枚 + 5 枚大光晕
        const fireflyGeo = new THREE.BufferGeometry();
        const fireflyPos = new Float32Array(fireflyCount * 3);
        const fireflySpeeds = new Float32Array(fireflyCount);
        const fireflyPhases = new Float32Array(fireflyCount);
        const fireflySizes = new Float32Array(fireflyCount);

        for (let i = 0; i < fireflyCount; i++) {
            // 散布于近景 26° 视锥景深前廊 (Z: -10 ~ -30)
            const depth = 10.0 + Math.random() * 20.0;
            const halfH = depth * 0.231;
            const halfW = halfH * 1.778;
            fireflyPos[i * 3 + 0] = (Math.random() - 0.5) * 1.8 * halfW;
            fireflyPos[i * 3 + 1] = (Math.random() - 0.5) * 1.8 * halfH;
            fireflyPos[i * 3 + 2] = -depth;

            // 移动速度减缓为 0.8 倍
            fireflySpeeds[i] = (0.35 + Math.random() * 0.45) * 0.8;
            fireflyPhases[i] = Math.random() * Math.PI * 2.0;

            if (i < 30) {
                // 原 30 枚：光晕控制在 15px ~ 30px
                fireflySizes[i] = 15.0 + Math.random() * 15.0;
            } else {
                // 5 枚大光圈：光晕设定为 32px
                fireflySizes[i] = 32.0;
            }
        }

        fireflyGeo.setAttribute('position', new THREE.BufferAttribute(fireflyPos, 3));
        fireflyGeo.setAttribute('aSpeed', new THREE.BufferAttribute(fireflySpeeds, 1));
        fireflyGeo.setAttribute('aPhase', new THREE.BufferAttribute(fireflyPhases, 1));
        fireflyGeo.setAttribute('aSize', new THREE.BufferAttribute(fireflySizes, 1));

        const fireflyVertexShader = `
            attribute float aSpeed;
            attribute float aPhase;
            attribute float aSize;
            uniform float uTime;
            uniform vec2 uMouseParallax;
            varying float vIntensity;

            void main() {
                vec3 pos = position;
                float t = uTime * aSpeed + aPhase;
                // 移动速度减缓为 0.8 倍，空间有机漫游更显沉静从容
                pos.x += (sin(t * 0.7) * 2.0 + cos(t * 1.3) * 1.0) * 0.8 + uMouseParallax.x * (0.5 + sin(aPhase) * 0.25);
                pos.y += (cos(t * 0.6) * 1.6 + sin(t * 1.1) * 0.8) * 0.8 + uMouseParallax.y * (0.5 + cos(aPhase) * 0.25);
                pos.z += sin(t * 0.4) * 0.96;

                vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
                gl_Position = projectionMatrix * mvPosition;

                // 精准映射尺寸：30 枚维持在 15~30px，10 枚精准定在 35px
                gl_PointSize = aSize * clamp(20.0 / -mvPosition.z, 0.90, 1.10);

                // 呼吸式渐明渐暗 (0.25 ~ 0.95 柔和忽明忽暗)
                float pulse = 0.5 + 0.5 * sin(t * 1.4);
                vIntensity = 0.30 + 0.65 * pulse * pulse;
            }
        `;

        const fireflyFragmentShader = `
            uniform float uAppearProgress;
            varying float vIntensity;

            void main() {
                if (uAppearProgress <= 0.001) discard;

                vec2 uv = gl_PointCoord - vec2(0.5);
                float dist = length(uv);
                if (dist > 0.5) discard;

                // 1. 广域反比例发散光晕 (Glow Halo)
                float glow = pow(max(0.0, 1.0 - dist * 2.0), 1.8);

                // 2. 针尖聚光白金高光核 (Core Center)
                float core = pow(max(0.0, 1.0 - dist * 5.0), 2.2);

                // 3. 沉香赤金双层色相：高亮白金核心 (#fffbee) -> 外缘沉郁赤金 (#e09520)
                vec3 haloColor = vec3(0.92, 0.64, 0.16); // 沉郁琥珀金
                vec3 coreColor = vec3(1.0, 0.98, 0.88); // 白金强发光核
                vec3 finalColor = mix(haloColor, coreColor, core * 0.88);

                // 通透 Alpha：由阶段推进变量 uAppearProgress 精准控制显隐
                float finalAlpha = vIntensity * glow * (0.50 + core * 0.45) * uAppearProgress;

                gl_FragColor = vec4(finalColor, finalAlpha);
            }
        `;

        const firefliesMat = new THREE.ShaderMaterial({
            vertexShader: fireflyVertexShader,
            fragmentShader: fireflyFragmentShader,
            uniforms: {
                uTime: { value: 0.0 },
                uMouseParallax: { value: new THREE.Vector2(0.0, 0.0) },
                uAppearProgress: { value: 0.0 }
            },
            transparent: true,
            depthWrite: false,
            depthTest: false
        });

        const firefliesMesh = new THREE.Points(fireflyGeo, firefliesMat);
        scene.add(firefliesMesh);



        // 5. 交互控制：六进长卷深层漫步 (6 级纯净景观位)
        const SCENIC_STOPS = [
            { x: -35.0, z:  125.0, lookX: -35.0, lookY: -1.0, lookZ:  -55.0 }, // 0: 一号远眺 (序卷文人题跋)
            { x: -35.0, z:   42.0, lookX: -35.0, lookY: -1.0, lookZ:  -55.0 }, // 1: 一号特写 (介休祆神楼)
            { x:  28.0, z:  -35.0, lookX:  35.0, lookY: -2.5, lookZ: -110.0 }, // 2: 二号前瞻 (浑源悬空寺 · 绝壁山峦远眺与营建秘录)
            { x:  35.0, z:  -68.0, lookX:  35.0, lookY: -2.5, lookZ: -110.0 }, // 3: 二号特写 (浑源悬空寺 · 拔地封顶构件特写)
            { x:   0.0, z:  -82.0, lookX:   0.0, lookY: -1.8, lookZ: -180.0 }, // 4: 三号前瞻 (永乐仙境前庭配景全貌 · 石狮远山飞鸟)
            { x:   0.0, z: -105.0, lookX:   0.0, lookY: -2.5, lookZ: -180.0 }  // 5: 三号特写 (芮城永乐宫三清殿宏伟特写与朝元图)
        ];

        let navProgress = 0.0;
        let targetNavProgress = 0.0;
        let lastWheelTime = 0;

        let mouseX = 0, mouseY = 0;
        let targetOffsetX = 0, targetOffsetY = 0;
        let currentOffsetX = 0, currentOffsetY = 0;

        const bgRaycaster = new THREE.Raycaster();
        const bgMouseVec2 = new THREE.Vector2();
        let rippleCursor = 0;
        let lastRippleUv = { x: -10.0, y: -10.0 };

        // 《朝元图》时光复原透镜光标射线拾取与平滑跟随系统
        const muralRaycaster = new THREE.Raycaster();
        const muralMouseVec2 = new THREE.Vector2();
        let targetLensUv = new THREE.Vector2(0.5, 0.5);
        let curLensUv = new THREE.Vector2(0.5, 0.5);

        const inkCursor = document.getElementById('ink-cursor');
        const brushSvg = document.getElementById('brush-svg');
        const inkCanvas = document.getElementById('ink-canvas');
        const stop4Container = document.getElementById('narrative-stop4');
        // 移动端完全关闭毛笔与水墨粒子 Canvas，仅桌面端启用
        if (isTouchDevice) {
            if (inkCursor) inkCursor.style.display = 'none';
            if (inkCanvas) inkCanvas.style.display = 'none';
        }
        const inkCtx = (!isTouchDevice && inkCanvas) ? inkCanvas.getContext('2d') : null;
        let inkWidth = inkCanvas ? (inkCanvas.width = viewW) : viewW;
        let inkHeight = inkCanvas ? (inkCanvas.height = viewH) : viewH;

        let cursorVisible = false;
        let clientMouseX = -9999, clientMouseY = -9999;
        let prevMouseX = -100, prevMouseY = -100;
        const inkParticles = [];

        window.addEventListener('mousemove', (e) => {
            const mapped = mapClientToLogical(e.clientX, e.clientY);
            clientMouseX = mapped.x;
            clientMouseY = mapped.y;

            if (!isTouchDevice) {
                if (!cursorVisible) {
                    if (inkCursor && !isOverMural) inkCursor.style.opacity = '1';
                    cursorVisible = true;
                }
                if (inkCursor) {
                    inkCursor.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
                }

                const dx = clientMouseX - prevMouseX;
                const dy = clientMouseY - prevMouseY;
                const dist = Math.sqrt(dx * dx + dy * dy);

                // 第一版水墨与朱砂拖尾算法：平滑滴落深墨 + 朱砂微粒 (当在朝元图壁画透镜区域或展开考据卡片时静默不滴墨，杜绝全屏闪屏)
                const stop4ActiveNow = (typeof stop4Container !== 'undefined') && stop4Container && stop4Container.classList.contains('active');
                if (!isOverMural && !stop4ActiveNow && dist > 4 && prevMouseX > 0) {
                    const count = Math.min(3, Math.floor(dist / 12) + 1);
                    for (let i = 0; i < count; i++) {
                        const ratio = i / count;
                        inkParticles.push({
                            x: prevMouseX + dx * ratio + (Math.random() - 0.5) * 4,
                            y: prevMouseY + dy * ratio + (Math.random() - 0.5) * 4,
                            radius: Math.random() * 2.8 + 1.2,
                            maxRadius: Math.random() * 5.0 + 3.0, // 宣纸浸润微扩散
                            alpha: Math.random() * 0.35 + 0.25,
                            decay: Math.random() * 0.015 + 0.018,
                            color: Math.random() > 0.82 ? '179, 57, 40' : '43, 37, 32' // 第一版朱砂比例与深墨色
                        });
                    }
                }
            }
            prevMouseX = clientMouseX;
            prevMouseY = clientMouseY;

            mouseX = (clientMouseX / viewW) * 2 - 1;
            mouseY = -(clientMouseY / viewH) * 2 + 1;
            const stop4ActiveNow2 = (typeof stop4Container !== 'undefined') && stop4Container && stop4Container.classList.contains('active');
            const inStop4Zone = (typeof navProgress !== 'undefined') && Math.abs(navProgress - 4.0) < 0.35;
            if (stop4ActiveNow2 || inStop4Zone) {
                targetOffsetX = 0;
                targetOffsetY = 0;
            } else {
                targetOffsetX = mouseX * 2.8;
                targetOffsetY = mouseY * 1.5;
            }

            // 水墨流体交互：仅在景位 0 (序卷题跋，navProgress <= 0.45) 保留鼠标水墨波纹效果
            if (!isTouchDevice && navProgress <= 0.45) {
                bgMouseVec2.set(mouseX, mouseY);
                bgRaycaster.setFromCamera(bgMouseVec2, camera);
                const intersects = bgRaycaster.intersectObject(bgMesh);
                if (intersects.length > 0) {
                    const uv = intersects[0].uv;
                    const rdx = uv.x - lastRippleUv.x;
                    const rdy = uv.y - lastRippleUv.y;
                    const distSq = rdx * rdx + rdy * rdy;
                    if (distSq > 0.00018) { // 鼠标位移触发阈值
                        const nowSec = performance.now() * 0.001;
                        const speed = Math.min(2.0, Math.sqrt(distSq) * 40.0);
                        bgRippleArray[rippleCursor].set(uv.x, uv.y, nowSec, Math.max(0.8, speed));
                        rippleCursor = (rippleCursor + 1) % 8;
                        lastRippleUv = { x: uv.x, y: uv.y };
                    }
                }
            }
        });

        // 第一版落笔：破墨大墨晕绽放 Bloom 与微压立锋（仅桌面端）
        window.addEventListener('mousedown', (e) => {
            if (isTouchDevice) return;
            if (inkCursor) inkCursor.classList.add('grabbing');
            if (brushSvg) brushSvg.classList.add('active');
            if (isOverMural || e.target.closest('#narrative-stop4')) return;

            // 产生扩散大墨晕
            for (let i = 0; i < 6; i++) {
                inkParticles.push({
                    x: e.clientX + (Math.random() - 0.5) * 8,
                    y: e.clientY + (Math.random() - 0.5) * 8,
                    radius: Math.random() * 3 + 2,
                    maxRadius: Math.random() * 16 + 10,
                    alpha: 0.55,
                    decay: 0.014,
                    color: Math.random() > 0.75 ? '179, 57, 40' : '43, 37, 32'
                });
            }
        });

        window.addEventListener('mouseup', () => {
            if (isTouchDevice) return;
            if (inkCursor) inkCursor.classList.remove('grabbing');
            if (brushSvg) brushSvg.classList.remove('active');
        });

        // 交互构件悬停感应：轻微上提灵动响应
        document.addEventListener('mouseover', (e) => {
            if (!brushSvg) return;
            if (e.target.closest('button, a, .hotspot-marker, .hotspot-card, .insc-seal, .insc-col, .scenic-card, .booklet-btn, .booklet-cover, .booklet-panel, .roof-entry-plaque, .s1-beast-tag, .s1-header-close, .s1-stage-nav-btn, [cursor="pointer"], [role="button"]')) {
                brushSvg.classList.add('hovering');
            } else {
                brushSvg.classList.remove('hovering');
            }
        });

        document.addEventListener('mouseleave', () => {
            if (inkCursor) {
                inkCursor.style.opacity = '0';
                cursorVisible = false;
            }
        });

        document.addEventListener('mouseenter', () => {
            if (inkCursor && !isOverMural) {
                inkCursor.style.opacity = '1';
                cursorVisible = true;
            }
        });

        // 滚轮推进控制 (0.0 -> 5.0，连续深入六进院落，丝滑流畅过渡)
        window.addEventListener('wheel', (e) => {
            const stop4El = document.getElementById('narrative-stop4');
            if (stop4El && (stop4El.classList.contains('active') || stop4El.style.display === 'block')) return;

            const stop2El = document.getElementById('narrative-stop2');
            if (stop2El && stop2El.classList.contains('expanded')) return;

            const s1ScrollEl = document.getElementById('scene1-beast-scroll-overlay');
            if (s1ScrollEl && s1ScrollEl.classList.contains('active')) return;

            const ovStop0El = document.getElementById('overview-stop0');
            if (ovStop0El && (ovStop0El.classList.contains('active') || ovStop0El.style.display === 'block')) return;

            const now = performance.now();
            const timeSinceLastWheel = now - lastWheelTime;

            // 静止停泊在景位中心时，过滤无意识手指微颤触碰 (<12)；一旦开始连续滚动则绝不丢弃任何滚轮事件
            if (timeSinceLastWheel > 220) {
                let isDeadCenter = false;
                for (let i = 0; i <= 5; i++) {
                    if (Math.abs(navProgress - i) < 0.08) {
                        isDeadCenter = true;
                        break;
                    }
                }
                if (isDeadCenter && Math.abs(e.deltaY) < 12) {
                    return;
                }
            }

            lastWheelTime = now;
            targetNavProgress += e.deltaY * 0.0016;
            targetNavProgress = Math.max(0.0, Math.min(5.0, targetNavProgress));
        }, { passive: true });

        // 移动端触屏手势支持（10px 防手抖点击阈值 + 3D 苍松/仙鹤触控直达 + 《朝元图》拖动锁定防误退）
        let touchStartLogicalX = 0;
        let touchStartLogicalY = 0;
        let lastTouchLogicalX = 0;
        let lastTouchLogicalY = 0;
        let isTouchingScreen = false;
        let isTouchDragging = false;
        let lastTouchDragEndTime = 0;

        window.addEventListener('touchstart', (e) => {
            if (!e.touches || e.touches.length === 0) return;
            const t = e.touches[0];
            const mapped = mapClientToLogical(t.clientX, t.clientY);
            touchStartLogicalX = lastTouchLogicalX = mapped.x;
            touchStartLogicalY = lastTouchLogicalY = mapped.y;
            isTouchingScreen = true;
            isTouchDragging = false;

            // 同步更新 NDC 坐标，使《朝元图》壁画放大镜立即可响应手指按压位置
            mouseX = (mapped.x / viewW) * 2 - 1;
            mouseY = -(mapped.y / viewH) * 2 + 1;
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (!isTouchingScreen || !e.touches || e.touches.length === 0) return;
            const t = e.touches[0];
            const mapped = mapClientToLogical(t.clientX, t.clientY);
            const dx = mapped.x - lastTouchLogicalX;
            const dy = mapped.y - lastTouchLogicalY;
            const totalMoveDist = Math.hypot(mapped.x - touchStartLogicalX, mapped.y - touchStartLogicalY);

            // 1. 防手抖死区：手指位移未超过 10px 时视为点击预备，绝不触发视角滚动，保证仙鹤/苍松/节点一触即开
            if (!isTouchDragging && totalMoveDist < 10) {
                return;
            }
            isTouchDragging = true;

            lastTouchLogicalX = mapped.x;
            lastTouchLogicalY = mapped.y;

            mouseX = (mapped.x / viewW) * 2 - 1;
            mouseY = -(mapped.y / viewH) * 2 + 1;

            // 2. 若当前正在探索卷三《朝元图》殿心壁画特写（activeHoverIndex === 5 或 lastFocusIndex === 5），单指拖动直接移动彩色复原透镜，不滚动长卷且不退出节点
            if ((activeHoverIndex === 5 || (lastFocusIndex === 5 && targetZoomFactor > 0.3)) && navProgress >= 4.6) {
                if (e.cancelable) e.preventDefault();
                return;
            }

            // 3. 若在首屏「三晋三筑营造总览」弹窗内滑动，顺滑收起总览并步入卷一
            const ovStop0El = document.getElementById('overview-stop0');
            if (ovStop0El && ovStop0El.classList.contains('active')) {
                const totalSwipe = (touchStartLogicalY - mapped.y) + (touchStartLogicalX - mapped.x) * 0.6;
                if (totalSwipe > 36) {
                    if (typeof closeOverviewStop0 === 'function') closeOverviewStop0();
                    targetNavProgress = 1.0;
                    isTouchingScreen = false;
                }
                return;
            }

            // 4. 若其它大型考据弹窗处于打开状态，不触发长卷背景推进
            const stop4El = document.getElementById('narrative-stop4');
            if (stop4El && (stop4El.classList.contains('active') || stop4El.style.display === 'block')) return;

            const stop2El = document.getElementById('narrative-stop2');
            if (stop2El && stop2El.classList.contains('expanded')) return;

            const s1ScrollEl = document.getElementById('scene1-beast-scroll-overlay');
            if (s1ScrollEl && s1ScrollEl.classList.contains('active')) return;

            if (e.cancelable) e.preventDefault();

            // 兼容逻辑横屏下的上下滑动 (-dy) 与左右顺长卷滑动 (-dx)，幅度更大者驱动长卷推进
            const primaryDelta = Math.abs(dy) >= Math.abs(dx) ? -dy : -dx;
            lastWheelTime = performance.now();
            targetNavProgress += primaryDelta * 0.0042;
            targetNavProgress = Math.max(0.0, Math.min(5.0, targetNavProgress));
        }, { passive: false });

        window.addEventListener('touchend', (e) => {
            if (!isTouchingScreen) return;
            isTouchingScreen = false;
            if (isTouchDragging) {
                lastTouchDragEndTime = performance.now();
                isTouchDragging = false;
                return;
            }
            // 轻触点按（位移 < 10px）：若点在 3D 苍松或 3D 仙鹤/发光层上，立即触发对应弹窗，无需等待合成 click
            if (e.changedTouches && e.changedTouches.length > 0) {
                const t = e.changedTouches[0];
                const mapped = mapClientToLogical(t.clientX, t.clientY);
                const tapVec = new THREE.Vector2(
                    (mapped.x / viewW) * 2 - 1,
                    -(mapped.y / viewH) * 2 + 1
                );
                const tapRaycaster = new THREE.Raycaster();
                tapRaycaster.setFromCamera(tapVec, camera);

                // 场景零：点按 3D 苍松或发光层
                if (navProgress <= 0.42 && overviewStop0Container && !overviewStop0Container.classList.contains('active')) {
                    const treeTargets = [];
                    if (typeof treeMesh !== 'undefined') treeTargets.push(treeMesh);
                    if (typeof treeGlowMesh !== 'undefined') treeTargets.push(treeGlowMesh);
                    if (treeTargets.length > 0 && tapRaycaster.intersectObjects(treeTargets).length > 0) {
                        openOverviewStop0();
                        return;
                    }
                }
                // 场景四（卷三前瞻）：点按 3D 仙鹤或仙鹤发光层
                if (navProgress >= 3.45 && navProgress <= 4.50 && stop4Container && !stop4Container.classList.contains('active')) {
                    const craneTargets = [];
                    if (typeof bg3CraneMesh !== 'undefined') craneTargets.push(bg3CraneMesh);
                    if (typeof craneGlowMesh !== 'undefined') craneTargets.push(craneGlowMesh);
                    if (craneTargets.length > 0 && tapRaycaster.intersectObjects(craneTargets).length > 0) {
                        openStop4FromCrane();
                        return;
                    }
                }
            }
        }, { passive: true });

        const handleViewportChange = () => {
            updateViewportMetrics();
            camera.aspect = viewW / viewH;
            camera.updateProjectionMatrix();
            renderer.setSize(viewW, viewH);
            if (inkCanvas) {
                inkWidth = inkCanvas.width = viewW;
                inkHeight = inkCanvas.height = viewH;
            }
        };
        window.addEventListener('resize', handleViewportChange);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', handleViewportChange);
        }
        window.addEventListener('orientationchange', () => {
            setTimeout(handleViewportChange, 120);
        });

        function smooth(t) {
            return t * t * (3.0 - 2.0 * t);
        }

        const inscStop0 = document.getElementById('inscription-stop0');
        const chapterBadge = document.getElementById('chapter-badge');

        const CHAPTER_CONFIGS = [
            {
                titleHtml: '卷一 · <ruby>介<rt>jiè</rt></ruby><ruby>休<rt>xiū</rt></ruby><ruby>祆<rt>xiān</rt></ruby><ruby>神<rt>shén</rt></ruby><ruby>楼<rt>lóu</rt></ruby>',
                sub: '三彩神兽与异域木构',
                hint: '点击节点看详情'
            },
            {
                titleHtml: '卷二 · <ruby>浑<rt>hún</rt></ruby><ruby>源<rt>yuán</rt></ruby><ruby>悬<rt>xuán</rt></ruby><ruby>空<rt>kōng</rt></ruby><ruby>寺<rt>sì</rt></ruby>',
                subPreview: '绝壁深涧 · 营建秘录',
                subDetail: '绝壁悬木与奇险力学',
                hintPreview: '点击右侧折页阅秘',
                hintDetail: '点击节点看详情'
            },
            {
                titleHtml: '卷三 · <ruby>芮<rt>ruì</rt></ruby><ruby>城<rt>chéng</rt></ruby><ruby>永<rt>yǒng</rt></ruby><ruby>乐<rt>lè</rt></ruby><ruby>宫<rt>gōng</rt></ruby>',
                subPreview: '仙道古道 · 营建前瞻',
                subDetail: '道教祖庭 · 重彩仙庭',
                hintPreview: '点击仙鹤启卷考据',
                hintDetail: '点击节点看详情'
            }
        ];

        function getStopSpotAlpha(stopIdx, prog) {
            if (stopIdx === 1) {
                if (prog < 0.65 || prog > 1.35) return 0.0;
                if (prog < 0.90) return (prog - 0.65) / 0.25;
                if (prog <= 1.15) return 1.0;
                return 1.0 - (prog - 1.15) / 0.2;
            } else if (stopIdx === 3) {
                if (prog < 2.65 || prog > 3.35) return 0.0;
                if (prog < 2.90) return (prog - 2.65) / 0.25;
                if (prog <= 3.15) return 1.0;
                return 1.0 - (prog - 3.15) / 0.2;
            } else if (stopIdx === 5) {
                if (prog < 4.65) return 0.0;
                if (prog < 4.90) return (prog - 4.65) / 0.25;
                return 1.0;
            }
            return 0.0;
        }

        // 观景位 1/3/5 构件热点数据与归属景观位
        const hotspotData = [
            // 场景一：介休祆神楼 (Stop 1, navProgress ≈ 1.0)
            { pos: new THREE.Vector3(-33.2, 12.6, -54.0), stopIndex: 1 }, // 0: 祆神楼屋脊三彩兽吻
            { pos: new THREE.Vector3(-35.0, -10.8, -54.0), stopIndex: 1 }, // 1: 过街戏台斗栱

            // 场景三：浑源悬空寺 (Stop 3, navProgress ≈ 3.0)
            { pos: new THREE.Vector3(40.8, -3.2, -109.0), stopIndex: 3 }, // 2: 绝壁半插飞梁与立木
            { pos: new THREE.Vector3(46.5, 1.8, -109.0), stopIndex: 3 },  // 3: 三教殿悬空楼阁

            // 场景五：芮城永乐宫 (Stop 5, navProgress ≈ 5.0)
            { pos: new THREE.Vector3(-6.0, 6.5, -179.0), stopIndex: 5 }, // 4: 三清殿元代琉璃鸱吻
            { pos: new THREE.Vector3(0.0, -7.0, -179.0), stopIndex: 5 }   // 5: 殿心朝元图壁画
        ];

        const hotspotElements = [
            document.getElementById('hotspot-0'),
            document.getElementById('hotspot-1'),
            document.getElementById('hotspot-2'),
            document.getElementById('hotspot-3'),
            document.getElementById('hotspot-4'),
            document.getElementById('hotspot-5')
        ];

        // 构件特写机位状态管理与点击锁定交互
        let activeHoverIndex = -1; // -1: 无特写, 0..5: 构件特写索引
        let lastFocusIndex = -1;   // 记忆最近一次特写目标，保证退场插值平滑不瞬移闪屏
        let dismissedHoverIndex = -1; // 记录刚解锁的节点，防止鼠标未移开时下一帧立即重触发
        let zoomFactor = 0.0;
        let targetZoomFactor = 0.0;
        let activeTriggerOrigin = { x: 0, y: 0 }; // 记录触发瞬间的屏幕锚点坐标，彻底打破抽搐死循环
        let isOverMural = false; // 壁画悬浮状态全局追踪

        function pinHotspot(idx) {
            const targetEl = hotspotElements[idx];
            if (!targetEl) return;
            hotspotElements.forEach((item, i) => {
                if (item && i !== idx) item.classList.remove('pinned', 'active');
            });
            targetEl.classList.add('pinned', 'active');
            activeHoverIndex = idx;
            lastFocusIndex = idx;
            targetZoomFactor = 1.0;
        }

        function unpinAndRestore() {
            hotspotElements.forEach(item => {
                if (item) item.classList.remove('pinned', 'active');
            });
            activeHoverIndex = -1;
            targetZoomFactor = 0.0;
        }

        // ==========================================
        // 观景位 1（介休祆神楼）：五大屋顶琉璃脊兽中堂立轴数据与交互控制
        // ==========================================
        const S1_BEAST_ACTS = [
            {
                tabTitle: "蹙眉獬豸",
                metaTag: "晋中琉璃 · 市井反差萌法兽",
                title: "明代黄琉璃<ruby>蹙<rt>cù</rt></ruby>眉<ruby>獬<rt>xiè</rt></ruby><ruby>豸<rt>zhì</rt></ruby>",
                videoSrc: "live/1.mp4",
                posterSrc: "live/1_poster.jpg",
                pillColor: "明代娇黄琉璃生釉",
                pillOrigin: "介休琉璃世家匠作遗存",
                pillLocation: "下层垂脊单体走兽",
                pillMeaning: "秉公明理 · 辟邪护宅",
                feature: "蹲坐在弧形筒瓦上，身披整齐细密的金黄龙鳞，最抓人眼球的是它圆睁的双眼与微微蹙起的眉头，透出一股<strong>认真办案又有点无辜的反差萌</strong>。",
                culture: "獬豸自古是能辨善恶、遇不公即以角顶之的铁面法兽。明代介休琉璃窑工匠将原本凶悍的猛兽赋予了市井人情味——它不只用于断案，更是民间祈求<strong>家宅端正、鬼祟不扰</strong>的镇宅精灵。"
            },
            {
                tabTitle: "卷尾螭吻",
                metaTag: "正脊之首 · 介休孔雀蓝巅峰",
                title: "孔雀蓝三彩卷尾<ruby>螭<rt>chī</rt></ruby>吻",
                videoSrc: "live/2.mp4",
                posterSrc: "live/2_poster.jpg",
                pillColor: "孔雀蓝、翡翠绿、琥珀黄三彩",
                pillOrigin: "介休何氏侯氏世家窑火绝艺",
                pillLocation: "十字歇山顶正脊四端吞脊吻",
                pillMeaning: "以水克火 · 封脊防渗",
                feature: "通体施介休特有的<strong>高饱和度孔雀蓝与翠绿生釉</strong>。巨龙怒目圆睁，巨吻大张死死咬合住整条屋脊；颈后长鬣如水浪怒张，龙身急剧翻卷腾空，尾梢如漩涡般盘旋翻涌。",
                culture: "安设在祆神楼十字歇山顶的脊端交汇处。在力学上，它是<strong>重达数百斤的咬合构件</strong>，能死死扣紧瓦垄、封堵雨水内渗；在文化意象上，螭吻为传说中平生嗜水好吞的龙之九子，立于木构高楼之巅，取<strong>以水克火、永镇祝融</strong>之意。"
            },
            {
                tabTitle: "扬首望兽",
                metaTag: "垂脊前哨 · 迎风巡天瑞兽",
                title: "三彩扬首长颈望兽",
                videoSrc: "live/3.mp4",
                posterSrc: "live/3_poster.jpg",
                pillColor: "孔雀蓝颈、娇黄鳞甲三彩",
                pillOrigin: "明清晋商重镇高规格窑作",
                pillLocation: "垂脊与戗脊前段转折节点",
                pillMeaning: "翘首巡天 · 止滑固瓦",
                feature: "修长优美的颈部覆满深邃的孔雀蓝釉，胸腹与背部则披挂灿烂的金黄鳞甲。它高高扬起头颅，巨口微张、双目远眺，背鳍如火焰般向后翻卷，下方底座精雕<strong>白釉覆莲瓣纹</strong>。",
                culture: "位于倾斜垂脊的前沿阵地。古建屋面坡度陡峭，筒瓦极易因重力下滑，匠人便将封闭瓦钉的栓塞演变为昂首远眺的望兽。它既是力学上的<strong>止滑刹车桩</strong>，又是整座楼阁迎风破云、守望四方商路平安的瞭望先锋。"
            },
            {
                tabTitle: "胡服骑翼兽",
                metaTag: "丝路孤例 · 粟特圣犬巡脊队",
                title: "胡服骑翼兽与圣犬巡脊列队",
                videoSrc: "live/4.mp4",
                posterSrc: "live/4_poster.jpg",
                pillColor: "黄绿蓝三彩配连珠莲花瓦当",
                pillOrigin: "古波斯萨珊 · 粟特祆教遗风",
                pillLocation: "二层飞檐戗脊端头整列",
                pillMeaning: "圣犬护法 · 丝路光明",
                feature: "一条完整的飞檐脊兽队列：最前端是张口怒吼的碧绿吐舌龙头，紧接着蹲坐一尊<strong>极其罕见的黑绿釉写实家犬</strong>，后方则是巨口獠牙的吞脊怪兽与身披甲胄的胡人骑士，底部衬以一排翠绿圆瓦当。",
                culture: "这是介休祆神楼<strong>最核心的跨文化铁证</strong>！在中原传统官式建筑中，走兽队列绝不会出现普通家犬；而在古波斯拜火教中，<strong>狗是仅次于人类的神圣生灵</strong>，负责守护灵魂跨过裁判之桥。这列脊兽将粟特商帮的圣犬信仰与中原琉璃工艺完美熔铸于一炉。"
            },
            {
                tabTitle: "楼阁脊刹",
                metaTag: "正脊中枢 · 三重宝塔引雷针",
                title: "正脊楼阁式琉璃脊<ruby>刹<rt>chà</rt></ruby>",
                videoSrc: "live/5.mp4",
                posterSrc: "live/5_poster.jpg",
                pillColor: "孔雀蓝、月白、琥珀黄繁复堆塑",
                pillOrigin: "明代晋中楼阁式脊饰巅峰",
                pillLocation: "最高处主正脊正中央",
                pillMeaning: "镇压风雷 · 承接天光",
                feature: "耸立于正脊中央的微缩琉璃天宫：中央主楼为<strong>三层重檐歇山顶楼阁</strong>，两侧对称簇拥双层宝塔与持械神将，三座塔顶均插有直指苍穹的金属三叉戟，底座缠绕翻涌的孔雀蓝如意云头与牡丹花束。",
                culture: "整座祆神楼最高处的视觉中心与精神图腾。在营造功能上，它压在正脊正中，起到<strong>平衡整条屋脊荷载的定海神针</strong>作用；顶部的金属三叉戟兼具古代<strong>引雷避火</strong>的朴素科学智慧，又暗合拜火教崇尚天光圣火的最高礼制。"
            }
        ];

        const s1ScrollOverlay = document.getElementById('scene1-beast-scroll-overlay');
        const s1ScrollCloseBtn = document.getElementById('s1ScrollCloseBtn');
        const s1ArtworkStage = document.getElementById('s1ArtworkStage');
        const s1PosterImg = document.getElementById('s1BeastPosterImg');
        const s1LiveVideo = document.getElementById('s1BeastLiveVideo');
        const s1PrevBtn = document.getElementById('s1PrevBeastBtn');
        const s1NextBtn = document.getElementById('s1NextBeastBtn');
        const s1BeastTags = document.querySelectorAll('.s1-beast-tag');
        let currentS1BeastIdx = 0;

        function restoreS1Poster() {
            if (!s1LiveVideo || !s1PosterImg) return;
            s1LiveVideo.pause();
            s1LiveVideo.currentTime = 0;
            s1LiveVideo.style.display = 'none';
            s1PosterImg.style.opacity = '1';
        }

        function playS1VideoOnce() {
            if (!s1LiveVideo || !s1PosterImg) return;
            s1LiveVideo.loop = false;
            s1LiveVideo.currentTime = 0;
            s1LiveVideo.style.display = 'block';
            s1LiveVideo.play().then(() => {
                s1PosterImg.style.opacity = '0';
            }).catch(() => {
                restoreS1Poster();
            });
        }

        if (s1LiveVideo) {
            s1LiveVideo.addEventListener('ended', () => {
                if (!s1LiveVideo.loop) {
                    restoreS1Poster();
                }
            });
        }

        if (s1ArtworkStage) {
            s1ArtworkStage.addEventListener('mouseenter', () => {
                if (!s1LiveVideo || !s1LiveVideo.getAttribute('src')) return;
                s1LiveVideo.loop = true;
                s1LiveVideo.style.display = 'block';
                s1LiveVideo.play().then(() => {
                    if (s1PosterImg) s1PosterImg.style.opacity = '0';
                }).catch(() => {});
            });

            s1ArtworkStage.addEventListener('mouseleave', () => {
                restoreS1Poster();
            });
        }

        function updateS1BeastView(idx) {
            currentS1BeastIdx = (idx + S1_BEAST_ACTS.length) % S1_BEAST_ACTS.length;
            const data = S1_BEAST_ACTS[currentS1BeastIdx];

            s1BeastTags.forEach((tag, i) => {
                tag.classList.toggle('active', i === currentS1BeastIdx);
            });

            if (s1PosterImg) {
                s1PosterImg.src = data.posterSrc;
                s1PosterImg.style.opacity = '1';
            }
            if (s1LiveVideo) {
                s1LiveVideo.pause();
                s1LiveVideo.src = data.videoSrc;
                s1LiveVideo.load();
            }

            const titleEl = document.getElementById('s1BeastTitle');
            const metaEl = document.getElementById('s1BeastMetaTag');
            const colorEl = document.getElementById('s1PillColor');
            const originEl = document.getElementById('s1PillOrigin');
            const locEl = document.getElementById('s1PillLocation');
            const meaningEl = document.getElementById('s1PillMeaning');
            const featEl = document.getElementById('s1BeastFeature');
            const cultEl = document.getElementById('s1BeastCulture');

            if (titleEl) titleEl.innerHTML = data.title;
            if (metaEl) metaEl.textContent = data.metaTag;
            if (colorEl) colorEl.textContent = data.pillColor;
            if (originEl) originEl.textContent = data.pillOrigin;
            if (locEl) locEl.textContent = data.pillLocation;
            if (meaningEl) meaningEl.textContent = data.pillMeaning;
            if (featEl) featEl.innerHTML = data.feature;
            if (cultEl) cultEl.innerHTML = data.culture;

            playS1VideoOnce();
        }

        function openS1BeastScroll(idx = 0) {
            unpinAndRestore();
            updateS1BeastView(idx);
            if (s1ScrollOverlay) {
                s1ScrollOverlay.classList.add('active');
            }
        }

        function closeS1BeastScroll() {
            if (s1ScrollOverlay) {
                s1ScrollOverlay.classList.remove('active');
            }
            restoreS1Poster();
        }

        s1BeastTags.forEach((tag) => {
            tag.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(tag.getAttribute('data-beast-idx'), 10) || 0;
                updateS1BeastView(idx);
            });
        });

        if (s1PrevBtn) {
            s1PrevBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                updateS1BeastView(currentS1BeastIdx - 1);
            });
        }
        if (s1NextBtn) {
            s1NextBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                updateS1BeastView(currentS1BeastIdx + 1);
            });
        }
        if (s1ScrollCloseBtn) {
            s1ScrollCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeS1BeastScroll();
            });
        }
        if (s1ScrollOverlay) {
            s1ScrollOverlay.addEventListener('click', (e) => {
                if (e.target === s1ScrollOverlay) {
                    closeS1BeastScroll();
                }
            });
            s1ScrollOverlay.addEventListener('wheel', (e) => {
                e.stopPropagation();
            }, { passive: false });
        }

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && s1ScrollOverlay && s1ScrollOverlay.classList.contains('active')) {
                closeS1BeastScroll();
            }
        });

        hotspotElements.forEach((el, idx) => {
            if (!el) return;
            // 卷一屋顶入口 (#hotspot-0)：点击直接在中央展开「屋顶脊兽详解」中堂立轴
            if (idx === 0) {
                const triggerRoofScroll = (e) => {
                    e.stopPropagation();
                    openS1BeastScroll(0);
                };
                el.addEventListener('click', triggerRoofScroll);
                const anchor = el.querySelector('.specimen-anchor');
                if (anchor) anchor.addEventListener('click', triggerRoofScroll);
                const plaque = el.querySelector('.roof-entry-plaque');
                if (plaque) plaque.addEventListener('click', triggerRoofScroll);
                return;
            }
            // 其余构件节点（如 #hotspot-1 过街戏台斗栱）：点击放大特写并展开简单介绍卡片；再次点击复位
            const triggerClick = (e) => {
                e.stopPropagation();
                if (activeHoverIndex !== idx) {
                    pinHotspot(idx);
                } else {
                    unpinAndRestore();
                }
            };
            el.addEventListener('click', triggerClick);
            const anchor = el.querySelector('.specimen-anchor');
            if (anchor) anchor.addEventListener('click', triggerClick);
            const plaque = el.querySelector('.roof-entry-plaque');
            if (plaque) plaque.addEventListener('click', triggerClick);
            const tag = el.querySelector('.anchor-tag');
            if (tag) tag.addEventListener('click', triggerClick);
        });

        // ==========================================
                // ==========================================
        // 观景位 4：永乐仙境前瞻 · 卡片初始收起与手风琴折页激活交互驱动
        // ==========================================
        // stop4Container 已在上方全局初始化
        const mainGlassPanel4 = document.getElementById('mainGlassPanel');
        const closeStop4Btn = document.getElementById('closeStop4Btn');
        const cards4 = document.querySelectorAll('#narrative-stop4 .card-fold');

        // 彻底阻断卷四考据面板上的滚轮穿透事件
        if (stop4Container) {
            stop4Container.addEventListener('wheel', (e) => {
                e.stopPropagation();
            }, { passive: false });
        }
        if (mainGlassPanel4) {
            mainGlassPanel4.addEventListener('wheel', (e) => {
                e.stopPropagation();
            }, { passive: false });
        }

        // 仙鹤唤起卷四考据大面板
        function openStop4FromCrane() {
            targetNavProgress = 4.0;
            navProgress = 4.0;
            targetOffsetX = 0;
            targetOffsetY = 0;
            currentOffsetX = 0;
            currentOffsetY = 0;
            targetZoomFactor = 0.0;
            zoomFactor = 0.0;
            activeHoverIndex = -1;
            if (stop4Container) {
                stop4Container.style.display = 'block';
                void stop4Container.offsetWidth; // 触发 reflow 产生淡入过渡
                stop4Container.classList.add('active');
                cards4.forEach(c => c.classList.remove('active'));
                const fold1 = document.querySelector('#narrative-stop4 .card-fold[data-fold="1"]');
                if (fold1) fold1.classList.add('active');
            }
        }

        function closeStop4Panel() {
            if (stop4Container) {
                stop4Container.classList.remove('active');
                setTimeout(() => {
                    if (stop4Container && !stop4Container.classList.contains('active')) {
                        stop4Container.style.display = 'none';
                    }
                }, 380);
            }
        }

        // ==========================================
        // 观景位 0：首屏左侧苍松点击唤起「三晋三筑营造总览」交互驱动
        // ==========================================
        const overviewStop0Container = document.getElementById('overview-stop0');
        const overviewStop0Panel = document.getElementById('overviewStop0Panel');
        const overviewStop0Backdrop = document.getElementById('overviewStop0Backdrop');
        const closeOverviewStop0Btn = document.getElementById('closeOverviewStop0Btn');
        const treeHotspotEl = document.getElementById('tree-hotspot');

        // 注入 ELEMENT_ASSETS 内置高清古建立面图，确保本地与云端零断图
        if (typeof ELEMENT_ASSETS !== 'undefined') {
            const ovImg1 = document.getElementById('ovImg1');
            const ovImg2 = document.getElementById('ovImg2');
            const ovImg3 = document.getElementById('ovImg3');
            if (ovImg1 && ELEMENT_ASSETS.building) ovImg1.src = ELEMENT_ASSETS.building;
            if (ovImg2 && ELEMENT_ASSETS.building2) ovImg2.src = ELEMENT_ASSETS.building2;
            if (ovImg3 && ELEMENT_ASSETS.building3) ovImg3.src = ELEMENT_ASSETS.building3;
        }

        // 在总览面板开启时向下拨动鼠标滚轮，自动收起总览并顺畅启动卷一漫游，强化「滚轮驱动」操作认知
        if (overviewStop0Container) {
            overviewStop0Container.addEventListener('wheel', (e) => {
                e.stopPropagation();
                if (e.deltaY > 12 && overviewStop0Container.classList.contains('active')) {
                    closeOverviewStop0();
                    targetNavProgress = 1.0;
                }
            }, { passive: false });
        }
        if (overviewStop0Panel) {
            overviewStop0Panel.addEventListener('wheel', (e) => {
                e.stopPropagation();
                if (e.deltaY > 12 && overviewStop0Container && overviewStop0Container.classList.contains('active')) {
                    closeOverviewStop0();
                    targetNavProgress = 1.0;
                }
            }, { passive: false });
        }

        function openOverviewStop0() {
            targetNavProgress = 0.0;
            navProgress = 0.0;
            targetOffsetX = 0;
            targetOffsetY = 0;
            currentOffsetX = 0;
            currentOffsetY = 0;
            if (overviewStop0Container) {
                overviewStop0Container.style.display = 'block';
                void overviewStop0Container.offsetWidth;
                overviewStop0Container.classList.add('active');
            }
        }

        function closeOverviewStop0() {
            if (overviewStop0Container) {
                overviewStop0Container.classList.remove('active');
                setTimeout(() => {
                    if (overviewStop0Container && !overviewStop0Container.classList.contains('active')) {
                        overviewStop0Container.style.display = 'none';
                    }
                }, 360);
            }
        }

        if (treeHotspotEl) {
            treeHotspotEl.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openOverviewStop0();
            });
        }

        if (closeOverviewStop0Btn) {
            closeOverviewStop0Btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeOverviewStop0();
            });
        }

        if (overviewStop0Backdrop) {
            overviewStop0Backdrop.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeOverviewStop0();
            });
        }

        // 点击底部「向下滚动鼠标滚轮 · 依序游历三晋长卷」引导栏亦可收起总览并步入卷一
        const ovScrollGuideBar = document.getElementById('overviewScrollGuideBar');
        if (ovScrollGuideBar) {
            ovScrollGuideBar.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeOverviewStop0();
                targetNavProgress = 1.0;
            });
        }

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overviewStop0Container && overviewStop0Container.classList.contains('active')) {
                closeOverviewStop0();
            }
        });

        // 点击首屏 3D 苍松实体 Mesh 或发光圈 (Raycaster 射线拾取，支持移动端旋转坐标映射)
        window.addEventListener('click', (e) => {
            if (navProgress > 0.42) return;
            if (overviewStop0Container && overviewStop0Container.classList.contains('active')) return;
            if (typeof treeMesh === 'undefined') return;

            const mapped = mapClientToLogical(e.clientX, e.clientY);
            const clickVec = new THREE.Vector2(
                (mapped.x / viewW) * 2 - 1,
                -(mapped.y / viewH) * 2 + 1
            );
            const treeRaycaster = new THREE.Raycaster();
            treeRaycaster.setFromCamera(clickVec, camera);
            const treeTargets = [treeMesh];
            if (typeof treeGlowMesh !== 'undefined') treeTargets.push(treeGlowMesh);
            const hits = treeRaycaster.intersectObjects(treeTargets);
            if (hits.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                openOverviewStop0();
            }
        });

        // 1. 点击仙鹤 2D 悬浮引注
        const craneHotspotEl = document.getElementById('crane-hotspot');
        if (craneHotspotEl) {
            craneHotspotEl.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openStop4FromCrane();
            });
        }

        // 2. 点击 3D 仙鹤实体 Mesh 或仙鹤发光圈 (Raycaster 射线拾取，支持移动端旋转坐标映射)
        window.addEventListener('click', (e) => {
            if (navProgress < 3.45 || navProgress > 4.50) return;
            if (stop4Container && stop4Container.classList.contains('active')) return;
            if (typeof bg3CraneMesh === 'undefined') return;

            const mapped = mapClientToLogical(e.clientX, e.clientY);
            const clickVec = new THREE.Vector2(
                (mapped.x / viewW) * 2 - 1,
                -(mapped.y / viewH) * 2 + 1
            );
            const craneRaycaster = new THREE.Raycaster();
            craneRaycaster.setFromCamera(clickVec, camera);
            const craneTargets = [bg3CraneMesh];
            if (typeof craneGlowMesh !== 'undefined') craneTargets.push(craneGlowMesh);
            const hits = craneRaycaster.intersectObjects(craneTargets);
            if (hits.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                openStop4FromCrane();
            }
        });

        // 点击右上角 ✕ 按钮或背景暗幕收起卡片
        if (closeStop4Btn) {
            closeStop4Btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeStop4Panel();
            });
        }
        const backdrop4El = document.getElementById('scene4Backdrop');
        if (backdrop4El) {
            backdrop4El.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeStop4Panel();
            });
        }

        // 手风琴折页切换交互
        cards4.forEach(card => {
            card.addEventListener('click', (e) => {
                e.stopPropagation();
                // 确保父级处于展开激活状态
                if (stop4Container && !stop4Container.classList.contains('active')) {
                    stop4Container.classList.add('active');
                }
                const isCurrentActive = card.classList.contains('active');
                if (!isCurrentActive) {
                    cards4.forEach(c => c.classList.remove('active'));
                    card.classList.add('active');
                }
            });
        });

        const diagMineralImg4 = document.getElementById('diagramMineralImg');
        const diagMineralTag4 = document.getElementById('diagramMineralTag');
        const specimenCards4 = document.querySelectorAll('#narrative-stop4 .specimen-card');
        specimenCards4.forEach(card => {
            const activateSpecimenCard = (e) => {
                if (e && e.type === 'click') e.stopPropagation();
                specimenCards4.forEach(c => c.classList.remove('active'));
                card.classList.add('active');

                if (diagMineralImg4 && card.dataset.mineralImg) {
                    diagMineralImg4.style.opacity = '0.3';
                    setTimeout(() => {
                        diagMineralImg4.src = card.dataset.mineralImg;
                        if (diagMineralTag4 && card.dataset.caption) {
                            diagMineralTag4.textContent = card.dataset.caption;
                        }
                        diagMineralImg4.style.opacity = '1';
                    }, 120);
                }
            };
            card.addEventListener('mouseenter', activateSpecimenCard);
            card.addEventListener('click', activateSpecimenCard);
        });

        // 切换折页图层：立面概述 <-> 规矩动效图解
        function toggleFoldDiagram(foldNum) {
            const artStage = document.getElementById(`artStage${foldNum}`);
            const btn = document.querySelector(`#narrative-stop4 .action-inspect-btn[data-toggle="${foldNum}"]`);
            if (!artStage) return;

            const isShowing = artStage.classList.contains('show-diagram');
            if (isShowing) {
                artStage.classList.remove('show-diagram');
                if (btn) {
                    btn.classList.remove('active-view');
                    let label = '查看搬迁图解';
                    if (foldNum === '2') label = '查看矿物色谱';
                    else if (foldNum === '3') label = '查看受力分析';
                    btn.innerHTML = `<span class="btn-emblem">❖</span><span class="btn-text">${label}</span><span class="btn-arrow">▸</span>`;
                }
            } else {
                artStage.classList.add('show-diagram');
                if (btn) {
                    btn.classList.add('active-view');
                    btn.innerHTML = `<span class="btn-arrow">◂</span><span class="btn-text">返回实景画卷</span>`;
                }
            }
        }

        // 按钮点击触发
        const actionBtns4 = document.querySelectorAll('#narrative-stop4 .action-inspect-btn');
        actionBtns4.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleFoldDiagram(btn.dataset.toggle);
            });
        });

        // 三个折页右侧图片区域点击时自动翻页到图解，再次点击返回概述
        ['1', '2', '3'].forEach(foldNum => {
            const artStage = document.getElementById(`artStage${foldNum}`);
            if (artStage) {
                artStage.addEventListener('click', (e) => {
                    // 如果点击的是图解内的微观卡片或交互元素，不要误触发整页切换
                    if (e.target.closest('.specimen-card') || e.target.closest('.relocation-timeline') || e.target.closest('.force-metrics') || e.target.closest('.thumb-item')) {
                        return;
                    }
                    e.stopPropagation();
                    toggleFoldDiagram(foldNum);
                });
            }
        });

        // 观景位 2：浑源悬空前瞻 · 3D 经折装四联全展动力学 (四页全现·折痕阴影)
        // ==========================================
        const bookletStop2 = document.getElementById('narrative-stop2');
        const bookRoot2 = document.getElementById('bookRoot2');
        const panelCover = document.getElementById('panelCover');
        const panel3 = document.getElementById('panel3');
        const panel2 = document.getElementById('panel2');
        const panel1 = document.getElementById('panel1');
        const fold2Backdrop = document.getElementById('fold2Backdrop');
        const coverExpandBtn = document.getElementById('coverExpandBtn');
        const coverCloseBtn = document.getElementById('coverCloseBtn');

        let targetFoldProg = 0.0;
        let curFoldProg = 0.0;

        // 核心折叠动力学：
        // 展开时进度为 1.0，各页交错微折 -20° / +40° / -40°
        // 保证四联每一页都面向视角 94% 展开呈现，绝不遮挡遮盖
        function updateFold2Angles(progress) {
            if (!panel3 || !panel2 || !panel1) return;

            // progress = 0.0 (合拢收于封面后) -> 1.0 (四折舒展全景态)
            const angle3 = progress * -20.0;
            const angle2 = progress * 40.0;
            const angle1 = progress * -40.0;

            panel3.style.transform = `rotateY(${angle3}deg)`;
            panel2.style.transform = `rotateY(${angle2}deg)`;
            panel1.style.transform = `rotateY(${angle1}deg)`;

            // 纸面折痕凹凸环境光照遮罩 (展开时呈现深邃真实阴影与凸棱反光)
            const shadowDepth = progress * 0.32;
            if (panelCover) panelCover.style.setProperty('--shadow-left', (shadowDepth * 0.4).toFixed(3));
            panel3.style.setProperty('--shadow-right', (shadowDepth * 0.9).toFixed(3));
            panel3.style.setProperty('--shadow-left', (shadowDepth * 0.6).toFixed(3));
            panel2.style.setProperty('--shadow-right', (shadowDepth * 0.6).toFixed(3));
            panel2.style.setProperty('--shadow-left', (shadowDepth * 0.9).toFixed(3));
            panel1.style.setProperty('--shadow-right', (shadowDepth * 0.7).toFixed(3));
            panel1.style.setProperty('--shadow-left', (shadowDepth * 0.3).toFixed(3));
        }

        function expandFoldBook() {
            if (!bookletStop2) return;
            bookletStop2.classList.add('expanded');
            targetFoldProg = 1.0; // 四联全面舒展展开
        }

        function closeFoldBook() {
            if (!bookletStop2) return;
            bookletStop2.classList.remove('expanded');
            targetFoldProg = 0.0; // 完全紧密收拢入封面
        }

        if (bookletStop2) {
            bookletStop2.addEventListener('wheel', (e) => {
                if (bookletStop2.classList.contains('expanded')) {
                    e.stopPropagation();
                }
            }, { passive: false });
            if (coverExpandBtn) {
                coverExpandBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    expandFoldBook();
                });
            }
            if (coverCloseBtn) {
                coverCloseBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeFoldBook();
                });
            }
            if (panelCover) {
                panelCover.addEventListener('click', (e) => {
                    if (!bookletStop2.classList.contains('expanded')) {
                        e.stopPropagation();
                        expandFoldBook();
                    }
                });
            }
            if (fold2Backdrop) {
                fold2Backdrop.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeFoldBook();
                });
            }
        }

        // 点击屏幕空白处平滑收拢折页（屏蔽触控拖拽结束后的合成 click 误触，且点击在《朝元图》壁画内部时不退出，仅移动彩色透镜）
        window.addEventListener('click', (e) => {
            if (performance.now() - lastTouchDragEndTime < 350) return;
            if (e.target.closest('.specimen-hotspot') || e.target.closest('#narrative-stop2') || e.target.closest('#narrative-stop4')) return;

            // 当《朝元图》特写节点处于激活状态时，点击或触摸壁画本体仅移动复原透镜，不退出特写；仅点击壁画外的空白背景才复位
            if (activeHoverIndex === 5 && typeof muralDetailMesh !== 'undefined') {
                const mapped = mapClientToLogical(e.clientX, e.clientY);
                const clickVec = new THREE.Vector2(
                    (mapped.x / viewW) * 2 - 1,
                    -(mapped.y / viewH) * 2 + 1
                );
                const muralClickRay = new THREE.Raycaster();
                muralClickRay.setFromCamera(clickVec, camera);
                const muralHits = muralClickRay.intersectObject(muralDetailMesh);
                if (muralHits.length > 0) {
                    targetLensUv.copy(muralHits[0].uv);
                    return;
                }
            }

            if (activeHoverIndex >= 0) {
                unpinAndRestore();
            }
            if (bookletStop2 && bookletStop2.classList.contains('expanded')) {
                closeFoldBook();
            }
        });

        let lastTime = performance.now();
        const projVec = new THREE.Vector3();

        // 6. 渲染动画循环（三进院落斜进游历 + 错时淡出淡入）
        function animate() {
            requestAnimationFrame(animate);

            const now = performance.now();
            const delta = Math.min((now - lastTime) * 0.001, 0.1);
            lastTime = now;
            const elapsed = now * 0.001;

            // 景观位全域强磁吸附与稳态定桩系统 (停滚后吸附归位，滚动中顺畅无阻)
            const nearestStop = Math.round(targetNavProgress);
            const distToStop = Math.abs(targetNavProgress - nearestStop);
            const isActivelyScrolling = (now - lastWheelTime) < 200;

            if (distToStop < 0.18) {
                // 仅在停滚后施加强磁吸附；正在连续滚动时不反向拖拽拉扯，彻底根除视角卡顿
                if (!isActivelyScrolling) {
                    targetNavProgress += (nearestStop - targetNavProgress) * 0.12;
                    if (distToStop < 0.0025) {
                        targetNavProgress = nearestStop;
                    }
                }
            }

            navProgress += (targetNavProgress - navProgress) * 0.06;

            // 题跋淡入淡出：仅在观景位 0 展现 (navProgress ∈ [0.0, 0.45])，深入一进院落时自然水墨消融
            if (inscStop0) {
                const inscAlpha = Math.max(0.0, Math.min(1.0, 1.0 - navProgress / 0.45));
                inscStop0.style.opacity = (inscAlpha * 0.95).toFixed(3);
                inscStop0.style.transform = `translate3d(0, ${(1.0 - inscAlpha) * -10}px, 0)`;
            }

            // 左上角三大古建主标：合并原卷2/3为「卷二 · 浑源悬空寺」，合并原卷4/5为「卷三 · 芮城永乐宫」，卷内连续常驻不闪烁
            if (chapterBadge) {
                let badgeAlpha = 0.0;
                let currentChapter = 0;
                let subText = '';
                let hintText = '';

                if (navProgress >= 0.55 && navProgress <= 1.35) {
                    currentChapter = 0; // 卷一 · 介休祆神楼
                    if (navProgress < 0.85) badgeAlpha = (navProgress - 0.55) / 0.3;
                    else if (navProgress <= 1.15) badgeAlpha = 1.0;
                    else badgeAlpha = 1.0 - (navProgress - 1.15) / 0.2;
                    subText = CHAPTER_CONFIGS[0].sub;
                    hintText = CHAPTER_CONFIGS[0].hint;
                } else if (navProgress >= 1.55 && navProgress <= 3.35) {
                    currentChapter = 1; // 卷二 · 浑源悬空寺（横跨景位 2 绝壁前瞻与景位 3 悬空寺特写，连续常驻）
                    if (navProgress < 1.85) badgeAlpha = (navProgress - 1.55) / 0.3;
                    else if (navProgress <= 3.15) badgeAlpha = 1.0;
                    else badgeAlpha = 1.0 - (navProgress - 3.15) / 0.2;
                    if (navProgress < 2.5) {
                        subText = CHAPTER_CONFIGS[1].subPreview;
                        hintText = CHAPTER_CONFIGS[1].hintPreview;
                    } else {
                        subText = CHAPTER_CONFIGS[1].subDetail;
                        hintText = CHAPTER_CONFIGS[1].hintDetail;
                    }
                } else if (navProgress >= 3.55 && navProgress <= 5.0) {
                    currentChapter = 2; // 卷三 · 芮城永乐宫（横跨景位 4 仙境前瞻与景位 5 三清殿特写，连续常驻）
                    if (navProgress < 3.85) badgeAlpha = (navProgress - 3.55) / 0.3;
                    else badgeAlpha = 1.0;
                    if (navProgress < 4.5) {
                        subText = CHAPTER_CONFIGS[2].subPreview;
                        hintText = CHAPTER_CONFIGS[2].hintPreview;
                    } else {
                        subText = CHAPTER_CONFIGS[2].subDetail;
                        hintText = CHAPTER_CONFIGS[2].hintDetail;
                    }
                }

                const badgeTitle = document.getElementById('badge-title');
                const badgeSub = document.getElementById('badge-sub');
                const badgeHint = document.getElementById('badge-hint');
                if (badgeTitle && CHAPTER_CONFIGS[currentChapter]) {
                    if (badgeTitle.dataset.chapterIdx !== String(currentChapter)) {
                        badgeTitle.innerHTML = CHAPTER_CONFIGS[currentChapter].titleHtml;
                        badgeTitle.dataset.chapterIdx = String(currentChapter);
                    }
                    if (badgeSub && badgeSub.textContent !== subText) {
                        badgeSub.textContent = subText;
                    }
                    if (badgeHint && badgeHint.textContent !== hintText) {
                        badgeHint.textContent = hintText;
                    }
                }

                chapterBadge.style.opacity = badgeAlpha.toFixed(3);
                chapterBadge.style.pointerEvents = badgeAlpha > 0.35 ? 'auto' : 'none';
                chapterBadge.style.transform = `translate3d(0, ${(1.0 - badgeAlpha) * -8}px, 0)`;
            }

            // 观景位 2：浑源悬空前瞻 · 3D 经折装动态浮现与由右向左阻尼展开
            if (bookletStop2) {
                let bookletAlpha = 0.0;
                if (navProgress >= 1.55 && navProgress <= 2.45) {
                    if (navProgress < 1.85) bookletAlpha = (navProgress - 1.55) / 0.3;
                    else if (navProgress <= 2.15) bookletAlpha = 1.0;
                    else bookletAlpha = 1.0 - (navProgress - 2.15) / 0.3;
                }
                bookletStop2.style.display = (bookletAlpha > 0.005) ? 'block' : 'none';
                bookletStop2.style.opacity = bookletAlpha.toFixed(3);
                // 容器由 CSS pointer-events 控制，仅折本自身接收交互，绝不全局吞没滚轮
                if (bookletAlpha < 0.05 && bookletStop2.classList.contains('expanded')) {
                    closeFoldBook();
                }

                // 3D 风琴折页动力学平滑阻尼
                if (typeof curFoldProg !== 'undefined' && typeof targetFoldProg !== 'undefined') {
                    curFoldProg += (targetFoldProg - curFoldProg) * 0.12;
                    updateFold2Angles(curFoldProg);
                }
            }

            // 观景位 0：首屏左侧苍松引注热点屏幕投影与发光联动
            const isStop0OverviewActive = overviewStop0Container && overviewStop0Container.classList.contains('active');
            if (treeHotspotEl && typeof treeMesh !== 'undefined') {
                let treePromptAlpha = 0.0;
                if (!isStop0OverviewActive && navProgress <= 0.42) {
                    treePromptAlpha = Math.max(0.0, 1.0 - navProgress / 0.38);
                }
                if (treePromptAlpha <= 0.01) {
                    treeHotspotEl.style.opacity = '0';
                    treeHotspotEl.style.pointerEvents = 'none';
                } else {
                    projVec.set(-43.2, -14.8, 5.0); // 左移3至 -43.2，保持树干中间高度
                    projVec.project(camera);
                    const sx = (projVec.x * 0.5 + 0.5) * viewW;
                    const sy = (-projVec.y * 0.5 + 0.5) * viewH;
                    treeHotspotEl.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;
                    treeHotspotEl.style.opacity = treePromptAlpha.toFixed(3);
                    treeHotspotEl.style.pointerEvents = treePromptAlpha > 0.25 ? 'auto' : 'none';
                }
            }
            if (typeof treeGlowMat !== 'undefined' && treeGlowMat.uniforms && treeGlowMat.uniforms.uOpacity) {
                let treeGlowAlpha = 0.0;
                if (!isStop0OverviewActive && navProgress <= 0.42) {
                    treeGlowAlpha = Math.max(0.0, 1.0 - navProgress / 0.38);
                }
                const treePulse = 0.55 + 0.45 * Math.sin(elapsed * 2.8);
                treeGlowMat.uniforms.uOpacity.value = treeGlowAlpha * treePulse;
            }

            // 观景位 4：仙鹤引注热点屏幕投影与 Stop 4 激活联动
            const craneTagEl = document.getElementById('crane-hotspot');
            const bookletStop4 = document.getElementById('narrative-stop4');
            const isStop4Active = bookletStop4 && bookletStop4.classList.contains('active');

            if (craneTagEl && typeof bg3CraneMesh !== 'undefined') {
                let craneAlpha = 0.0;
                if (!isStop4Active && navProgress >= 3.55 && navProgress <= 4.45) {
                    if (navProgress < 3.85) craneAlpha = (navProgress - 3.55) / 0.3;
                    else if (navProgress <= 4.15) craneAlpha = 1.0;
                    else craneAlpha = 1.0 - (navProgress - 4.15) / 0.3;
                }

                if (craneAlpha <= 0.01) {
                    craneTagEl.style.opacity = '0';
                    craneTagEl.style.pointerEvents = 'none';
                } else {
                    projVec.copy(bg3CraneMesh.position);
                    projVec.x += 6.6; // 置于仙鹤右侧身旁空白处
                    projVec.y += 0.5; // 置于仙鹤颈胸高度
                    projVec.project(camera);
                    const sx = (projVec.x * 0.5 + 0.5) * viewW;
                    const sy = (-projVec.y * 0.5 + 0.5) * viewH;
                    craneTagEl.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;
                    craneTagEl.style.opacity = craneAlpha.toFixed(3);
                    craneTagEl.style.pointerEvents = craneAlpha > 0.25 ? 'auto' : 'none';
                }
            }

            if (s1ScrollOverlay && s1ScrollOverlay.classList.contains('active')) {
                if (navProgress < 0.55 || navProgress > 1.45) {
                    closeS1BeastScroll();
                }
            }

            if (bookletStop4) {
                if (isStop4Active) {
                    bookletStop4.style.display = 'block';
                    bookletStop4.style.opacity = '1';
                    bookletStop4.style.pointerEvents = 'auto';
                    if (navProgress < 3.50 || navProgress > 4.50) {
                        bookletStop4.classList.remove('active');
                        bookletStop4.style.display = 'none';
                    }
                }
            }

            // 轨迹插值 (0 -> 1 -> 2 -> 3 -> 4 -> 5)
            const seg = Math.min(4, Math.floor(navProgress));
            const segT = smooth(navProgress - seg);

            const p0 = SCENIC_STOPS[seg];
            const p1 = SCENIC_STOPS[seg + 1] || p0;

            let curCamX = p0.x + (p1.x - p0.x) * segT;
            let curCamY = 0.0;
            let curCamZ = p0.z + (p1.z - p0.z) * segT;
            let curLookX = p0.lookX + (p1.lookX - p0.lookX) * segT;
            let curLookY = (p0.lookY !== undefined ? p0.lookY : -1.0) + ((p1.lookY !== undefined ? p1.lookY : -1.0) - (p0.lookY !== undefined ? p0.lookY : -1.0)) * segT;
            let curLookZ = p0.lookZ + (p1.lookZ - p0.lookZ) * segT;

            // 构件特写平滑自然拉近动画 (适度俯仰与稳态推进，保证节点位置平稳不乱跳)
            if (activeHoverIndex >= 0) {
                lastFocusIndex = activeHoverIndex;
            }
            zoomFactor += (targetZoomFactor - zoomFactor) * 0.055;
            if (zoomFactor > 0.001 && lastFocusIndex >= 0) {
                let focusCamX = curCamX;
                let focusCamY = curCamY;
                let focusCamZ = curCamZ;
                let focusLookX = curLookX;
                let focusLookY = curLookY;
                let focusLookZ = curLookZ;

                if (lastFocusIndex === 0) {
                    // 场景一：祆神楼屋脊三彩兽吻
                    focusCamY = 2.0;
                    focusCamZ = 18.0;
                    focusLookY = 0.8;
                } else if (lastFocusIndex === 1) {
                    // 场景一：祆神楼戏台莲花托角斗栱
                    focusCamY = -2.0;
                    focusCamZ = 18.0;
                    focusLookY = -2.4;
                } else if (lastFocusIndex === 2) {
                    // 场景二：悬空寺绝壁半插飞梁与立木 (平稳前推，无剧烈水平摆动，保持视界平稳)
                    focusCamX = 36.5;
                    focusCamY = -1.5;
                    focusCamZ = -82.0;
                    focusLookX = 37.0;
                    focusLookY = -1.8;
                } else if (lastFocusIndex === 3) {
                    // 场景二：悬空寺三教殿悬空楼阁 (平稳前推，自然居中)
                    focusCamX = 37.0;
                    focusCamY = 0.5;
                    focusCamZ = -82.0;
                    focusLookX = 37.5;
                    focusLookY = 0.0;
                } else if (lastFocusIndex === 4) {
                    // 场景三：永乐宫三清殿元代琉璃巨鸱吻
                    focusCamX = -2.5;
                    focusCamY = 1.2;
                    focusCamZ = -135.0;
                    focusLookX = -2.5;
                    focusLookY = -0.5;
                } else if (lastFocusIndex === 5) {
                    // 场景三：永乐宫殿心朝元图殿门深进 (正对大殿中央深进，清晰仰观重彩真迹)
                    focusCamX = 0.0;
                    focusCamY = -1.2;
                    focusCamZ = -135.0;
                    focusLookX = 0.0;
                    focusLookY = -1.2;
                }

                curCamX = curCamX * (1.0 - zoomFactor) + focusCamX * zoomFactor;
                curCamY = curCamY * (1.0 - zoomFactor) + focusCamY * zoomFactor;
                curCamZ = curCamZ * (1.0 - zoomFactor) + focusCamZ * zoomFactor;
                curLookX = curLookX * (1.0 - zoomFactor) + focusLookX * zoomFactor;
                curLookY = curLookY * (1.0 - zoomFactor) + focusLookY * zoomFactor;
                curLookZ = curLookZ * (1.0 - zoomFactor) + focusLookZ * zoomFactor;
            }

            // [核心状态阶段控制 (1 -> 2 -> 3 -> 4 -> 5)]
            if (navProgress <= 1.0) {
                // 阶段 1：推近一号建筑 (0.0 -> 1.0)
                const t = navProgress;
                buildingMat.uniforms.uAppearProgress.value = t;       // 建筑一由底向上生长
                buildingMat.uniforms.uDepartAlpha.value = 1.0;       // 建筑一常驻
                treeMat.uniforms.uDissolveProgress.value = t;         // 苍松由顶向下消融
                bg2Mat.uniforms.uEdgeAlpha.value = 0.0;              // 二号绝壁背景隐去 (0%)
                if (typeof bg2Layer1Mat !== 'undefined') bg2Layer1Mat.uniforms.uEdgeAlpha.value = 0.0;
                building2Mat.uniforms.uAppearProgress.value = 0.0;   // 二号建筑未浮现
                building3Mat.uniforms.uAppearProgress.value = 0.0;   // 三号建筑未浮现
                if (typeof treeRockLeftMat !== 'undefined') treeRockLeftMat.uniforms.uEdgeAlpha.value = 0.0;
                if (typeof treeRockRightMat !== 'undefined') treeRockRightMat.uniforms.uEdgeAlpha.value = 0.0;
                if (typeof bg3CraneMat !== 'undefined') { bg3CraneMat.uniforms.uEdgeAlpha.value = 0.0; bg3CraneMat.uniforms.uDissolveProgress.value = 0.0; }
                if (typeof skyBirdMats !== 'undefined') skyBirdMats.forEach(m => m.uniforms.uEdgeAlpha.value = 0.0);
                if (typeof firefliesMat !== 'undefined') firefliesMat.uniforms.uAppearProgress.value = 0.0;
            } else if (navProgress <= 2.0) {
                // 阶段 2：向斜前方深入至二号前瞻 · 峡谷远眺与营建秘录 (1.0 -> 2.0)
                const t = navProgress - 1.0; // t ∈ [0.0, 1.0]

                // 1. 一号建筑在前段 (t ∈ [0.0, 0.3]) 迅速水墨淡出
                const bldg1Depart = Math.max(0.0, 1.0 - t / 0.3);
                buildingMat.uniforms.uDepartAlpha.value = bldg1Depart;
                treeMat.uniforms.uDissolveProgress.value = 1.0;

                // 2. 一号建筑淡出后，峡谷两张背景平滑升至 100% 充盈不透明度 (提高在卷二的不透明度)
                let bg2Alpha = 0.0;
                if (t > 0.25) {
                    bg2Alpha = Math.min(0.80, ((t - 0.25) / 0.50) * 0.80);
                }
                bg2Mat.uniforms.uEdgeAlpha.value = bg2Alpha;        // 提高至 1.0 充盈不透明度
                if (typeof bg2Layer1Mat !== 'undefined') bg2Layer1Mat.uniforms.uEdgeAlpha.value = bg2Alpha; // 提高至 1.0 充盈不透明度

                // 3. 悬空寺木构楼阁在此景位保留为险绝峭壁自然风貌，尚未拔地，纯粹展现险绝金龙峡！
                building2Mat.uniforms.uAppearProgress.value = 0.0;
                building2Mat.uniforms.uDepartAlpha.value = 1.0;

                if (typeof bg3Mat !== 'undefined') bg3Mat.uniforms.uEdgeAlpha.value = 0.0;
                building3Mat.uniforms.uAppearProgress.value = 0.0;
                if (typeof treeRockLeftMat !== 'undefined') treeRockLeftMat.uniforms.uEdgeAlpha.value = 0.0;
                if (typeof treeRockRightMat !== 'undefined') treeRockRightMat.uniforms.uEdgeAlpha.value = 0.0;
                if (typeof bg3CraneMat !== 'undefined') { bg3CraneMat.uniforms.uEdgeAlpha.value = 0.0; bg3CraneMat.uniforms.uDissolveProgress.value = 0.0; }
                if (typeof skyBirdMats !== 'undefined') skyBirdMats.forEach(m => m.uniforms.uEdgeAlpha.value = 0.0);
                if (typeof firefliesMat !== 'undefined') firefliesMat.uniforms.uAppearProgress.value = 0.0;
            } else if (navProgress <= 3.0) {
                // 阶段 3：自二号前瞻深入至浑源悬空寺拔地特写 (2.0 -> 3.0)
                const t = navProgress - 2.0; // t ∈ [0.0, 1.0]

                buildingMat.uniforms.uDepartAlpha.value = 0.0;
                treeMat.uniforms.uDissolveProgress.value = 1.0;

                // 1. 背景 2 与背景 1 同样在向特写深入时优雅水墨淡出消融 (0.75 行程内自 1.0 平滑隐退)
                const bgFade = Math.max(0.0, 0.80 * (1.0 - t / 0.75));
                bg2Mat.uniforms.uEdgeAlpha.value = bgFade;
                if (typeof bg2Layer1Mat !== 'undefined') bg2Layer1Mat.uniforms.uEdgeAlpha.value = bgFade;

                // 2. 二号悬空寺木构在 (t ∈ [0.15, 1.0]) 从崖底直接在前侧拔地向上生长封顶
                let bldg2Prog = 0.0;
                if (t > 0.15) {
                    bldg2Prog = Math.min(1.0, (t - 0.15) / 0.85);
                }
                building2Mat.uniforms.uAppearProgress.value = bldg2Prog;
                building2Mat.uniforms.uDepartAlpha.value = 1.0;

                if (typeof bg3Mat !== 'undefined') bg3Mat.uniforms.uEdgeAlpha.value = 0.0;
                building3Mat.uniforms.uAppearProgress.value = 0.0;
                if (typeof treeRockLeftMat !== 'undefined') treeRockLeftMat.uniforms.uEdgeAlpha.value = 0.0;
                if (typeof treeRockRightMat !== 'undefined') treeRockRightMat.uniforms.uEdgeAlpha.value = 0.0;
                if (typeof bg3CraneMat !== 'undefined') { bg3CraneMat.uniforms.uEdgeAlpha.value = 0.0; bg3CraneMat.uniforms.uDissolveProgress.value = 0.0; }
                if (typeof skyBirdMats !== 'undefined') skyBirdMats.forEach(m => m.uniforms.uEdgeAlpha.value = 0.0);
                if (typeof firefliesMat !== 'undefined') firefliesMat.uniforms.uAppearProgress.value = 0.0;
            } else if (navProgress < 4.0) {
                // 阶段 4：自二号悬空寺过渡至四号永乐前瞻 (3.0 -> 4.0)
                const t = navProgress - 3.0; // t ∈ [0.0, 1.0]

                bg2Mat.uniforms.uEdgeAlpha.value = 0.0;
                if (typeof bg2Layer1Mat !== 'undefined') bg2Layer1Mat.uniforms.uEdgeAlpha.value = 0.0;
                buildingMat.uniforms.uDepartAlpha.value = 0.0;
                treeMat.uniforms.uDissolveProgress.value = 1.0;

                // 灵韵流金萤火：平滑浮现
                if (typeof firefliesMat !== 'undefined') {
                    firefliesMat.uniforms.uAppearProgress.value = Math.min(1.0, t / 0.8);
                }

                // 1. 二号建筑在前段 (t ∈ [0.0, 0.35]) 水墨淡出
                const bldg2Depart = Math.max(0.0, 1.0 - t / 0.35);
                building2Mat.uniforms.uDepartAlpha.value = bldg2Depart;

                // 2. 三号背景 (前庭石狮与山峦全貌) 在 (t ∈ [0.25, 0.75]) 透明度从 0% 升至 100% 完整展现
                let bg3Alpha = 0.0;
                if (t > 0.25) {
                    bg3Alpha = Math.min(1.0, (t - 0.25) / 0.5);
                }
                if (typeof bg3Mat !== 'undefined') {
                    bg3Mat.uniforms.uEdgeAlpha.value = bg3Alpha;
                }

                // 3. 仙鹤、背景左右石头树与天际群鸟配景逐渐显现
                let sceneryAlpha = 0.0;
                if (t > 0.25) {
                    sceneryAlpha = Math.min(1.0, (t - 0.25) / 0.5);
                }
                if (typeof treeRockLeftMat !== 'undefined') treeRockLeftMat.uniforms.uEdgeAlpha.value = sceneryAlpha;
                if (typeof treeRockRightMat !== 'undefined') treeRockRightMat.uniforms.uEdgeAlpha.value = sceneryAlpha;
                if (typeof bg3CraneMat !== 'undefined') { bg3CraneMat.uniforms.uEdgeAlpha.value = sceneryAlpha; bg3CraneMat.uniforms.uDissolveProgress.value = 0.0; }
                if (typeof skyBirdMats !== 'undefined') skyBirdMats.forEach(m => m.uniforms.uEdgeAlpha.value = sceneryAlpha);

                // 景位 4（永乐前瞻）中三号大殿完全不出现，保留给景位 5
                building3Mat.uniforms.uAppearProgress.value = 0.0;
            } else {
                // 阶段 5：自四号永乐前瞻深入至五号三清太殿与朝元图真迹 (4.0 -> 5.0)
                const t = navProgress - 4.0; // t ∈ [0.0, 1.0]

                buildingMat.uniforms.uDepartAlpha.value = 0.0;
                building2Mat.uniforms.uDepartAlpha.value = 0.0;
                bg2Mat.uniforms.uEdgeAlpha.value = 0.0;

                if (typeof firefliesMat !== 'undefined') {
                    firefliesMat.uniforms.uAppearProgress.value = 1.0;
                }

                // 三号背景保持 100%
                if (typeof bg3Mat !== 'undefined') {
                    bg3Mat.uniforms.uEdgeAlpha.value = 1.0;
                }

                // 近景仙鹤消融逐渐消失 (0.5行程内完全消融)
                const craneDissolve = Math.min(1.0, t / 0.5);
                if (typeof treeRockLeftMat !== 'undefined') treeRockLeftMat.uniforms.uEdgeAlpha.value = 1.0;
                if (typeof treeRockRightMat !== 'undefined') treeRockRightMat.uniforms.uEdgeAlpha.value = 1.0;
                if (typeof bg3CraneMat !== 'undefined') {
                    bg3CraneMat.uniforms.uEdgeAlpha.value = 1.0;
                    bg3CraneMat.uniforms.uDissolveProgress.value = craneDissolve;
                }
                if (typeof skyBirdMats !== 'undefined') skyBirdMats.forEach(m => m.uniforms.uEdgeAlpha.value = 1.0);

                // 三号中央太殿在 (t ∈ [0.15, 1.0]) 拔地生长封顶，高潮呈现
                let bldg3Prog = 0.0;
                if (t > 0.15) {
                    bldg3Prog = Math.min(1.0, (t - 0.15) / 0.85);
                }
                building3Mat.uniforms.uAppearProgress.value = bldg3Prog;
            }

            // 阻尼跟随与展区 4 绝对稳态锁定（彻底杜绝背景任何伸缩/缩进/视差抖动）
            const stop4IsActive = (typeof stop4Container !== 'undefined') && stop4Container && stop4Container.classList.contains('active');
            const inStop4Zone = Math.abs(navProgress - 4.0) < 0.25;

            if (stop4IsActive || inStop4Zone) {
                targetOffsetX = 0;
                targetOffsetY = 0;
                currentOffsetX = 0;
                currentOffsetY = 0;
                if (stop4IsActive) {
                    targetNavProgress = 4.0;
                    navProgress = 4.0;
                }
            } else {
                currentOffsetX += (targetOffsetX - currentOffsetX) * 0.05;
                currentOffsetY += (targetOffsetY - currentOffsetY) * 0.05;
            }

            if (stop4IsActive) {
                curCamX = 0.0;
                curCamY = 0.0;
                curCamZ = -82.0;
                curLookX = 0.0;
                curLookY = -1.8;
                curLookZ = -180.0;
                targetZoomFactor = 0.0;
                zoomFactor = 0.0;
                activeHoverIndex = -1;
                camera.position.set(0.0, 0.0, -82.0);
                camera.lookAt(0.0, -1.8, -180.0);
            } else {
                camera.position.x = curCamX + currentOffsetX;
                camera.position.y = curCamY + currentOffsetY;
                camera.position.z = curCamZ;
                camera.lookAt(curLookX, curLookY, curLookZ);
            }
            camera.updateMatrixWorld();

            // 殿心朝元图特写与时光透镜交互（仅在景位 5 且未激活卷四考据时生效）：
            isOverMural = false;
            if (typeof muralDetailMat !== 'undefined' && !stop4IsActive && navProgress >= 4.6) {
                const muralDetailAlpha = (lastFocusIndex === 5) ? zoomFactor : 0.0;
                muralDetailMat.uniforms.uOpacity.value = Math.max(0.0, Math.min(1.0, muralDetailAlpha));

                if (muralDetailAlpha > 0.02 && typeof muralDetailMesh !== 'undefined') {
                    muralMouseVec2.set(mouseX, mouseY);
                    muralRaycaster.setFromCamera(muralMouseVec2, camera);
                    const muralHits = muralRaycaster.intersectObject(muralDetailMesh);
                    if (muralHits.length > 0) {
                        targetLensUv.copy(muralHits[0].uv);
                        isOverMural = true;
                    }
                    curLensUv.lerp(targetLensUv, 0.18);
                    muralDetailMat.uniforms.uLensUv.value.copy(curLensUv);
                }
            } else if (typeof muralDetailMat !== 'undefined') {
                muralDetailMat.uniforms.uOpacity.value = 0.0;
            }
            if (inkCursor) {
                if (isOverMural) {
                    inkCursor.classList.add('in-mural');
                    if (inkCanvas) inkCanvas.classList.add('in-mural');
                } else {
                    inkCursor.classList.remove('in-mural');
                    if (inkCanvas) inkCanvas.classList.remove('in-mural');
                }
            }

            // 离开景位 0 (navProgress > 0.45) 时，立即静默淡退旧的水墨波纹，保持后景纯净
            if (navProgress > 0.45) {
                for (let i = 0; i < 8; i++) {
                    if (bgRippleArray[i].z > 0.0) bgRippleArray[i].z = -100.0;
                }
            }

            // 观景位 1/2/3：古建构件脉冲呼吸光点屏幕投影与防抽搐滞回触发 (当前帧相机矩阵直接投影)

            hotspotData.forEach((data, i) => {
                const el = hotspotElements[i];
                if (!el) return;
                const spotAlpha = getStopSpotAlpha(data.stopIndex, navProgress);

                if (spotAlpha <= 0.01) {
                    el.style.opacity = '0';
                    el.style.pointerEvents = 'none';
                    el.classList.remove('active', 'pinned');
                    if (activeHoverIndex === i) {
                        activeHoverIndex = -1;
                        targetZoomFactor = 0.0;
                    }
                    return;
                }

                // 将构件三维坐标投影至屏幕对应位置（纯显示投影，适配移动端旋转视口）
                projVec.copy(data.pos).project(camera);
                const sx = (projVec.x * 0.5 + 0.5) * viewW;
                const sy = (-projVec.y * 0.5 + 0.5) * viewH;
                el.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;
                el.style.opacity = spotAlpha.toFixed(3);
                el.style.pointerEvents = spotAlpha > 0.05 ? 'auto' : 'none';
            });

            // 背景长卷水墨流体涟漪更新
            if (typeof bgMat !== 'undefined' && bgMat.uniforms.uTime) {
                bgMat.uniforms.uTime.value = elapsed;
            }

            // 灵韵流金萤火动效与相机跟随
            firefliesMat.uniforms.uTime.value = elapsed;
            firefliesMat.uniforms.uMouseParallax.value.set(currentOffsetX, currentOffsetY);
            firefliesMesh.position.set(camera.position.x, camera.position.y, camera.position.z);
            firefliesMesh.quaternion.copy(camera.quaternion);

            // 流云自右向左循环 (双组放大一倍，降低不透明度至 50%~55% 呈现轻烟薄雾)
            cloudInstances.forEach(c => {
                c.mesh.position.x -= c.speed * delta * 1.0;
                if (c.mesh.position.x < c.xMin) {
                    c.mesh.position.x = c.xMax;
                }
                c.mesh.position.y = c.yBase + Math.sin(elapsed * 0.4 + c.phase) * 0.35;

                const distFromCenter = Math.abs(c.mesh.position.x);
                let edgeFade = 1.0;
                if (distFromCenter > 75.0) {
                    edgeFade = Math.max(0.0, 1.0 - (distFromCenter - 75.0) / 45.0);
                }
                c.mat.uniforms.uEdgeAlpha.value = edgeFade * (c.opacity !== undefined ? c.opacity : 0.55);
            });

            // 景位 3 右上天空三飞鸟编队自右向左高空掠影翱翔（头统一朝左，独立循环）
            if (typeof skyBirdMeshes !== 'undefined') {
                skyBirdMeshes.forEach(b => {
                    b.mesh.position.x -= b.cfg.speed * delta;
                    if (b.mesh.position.x < -45.0) {
                        b.mesh.position.x = 45.0 + (b.cfg.x - 20.2);
                    }
                    b.mesh.position.y = b.cfg.y + Math.sin(elapsed * 1.3 + b.cfg.phase) * 0.28;
                    b.mesh.rotation.z = Math.sin(elapsed * 1.1 + b.cfg.phase) * 0.02;
                });
            }

            // 景位 3 仙鹤优雅舒缓振翅呼吸浮动与发光标识呼吸律动
            if (typeof bg3CraneMesh !== 'undefined') {
                bg3CraneMesh.position.y = -9.8 + Math.sin(elapsed * 1.4) * 0.25;
                bg3CraneMesh.position.x = -14.0 + Math.cos(elapsed * 0.9) * 0.12;
                bg3CraneMesh.rotation.z = Math.sin(elapsed * 1.1) * 0.012;

                if (typeof craneGlowMesh !== 'undefined') {
                    craneGlowMesh.position.set(bg3CraneMesh.position.x + 2.0, bg3CraneMesh.position.y, bg3CraneMesh.position.z - 0.05); // 光圈向右移动 2 个单位
                    craneGlowMesh.rotation.z = bg3CraneMesh.rotation.z;
                    const isStop4ActiveNow = bookletStop4 && bookletStop4.classList.contains('active');
                    let glowAlpha = 0.0;
                    if (!isStop4ActiveNow && navProgress >= 3.55 && navProgress <= 4.45) {
                        if (navProgress < 3.85) glowAlpha = (navProgress - 3.55) / 0.3;
                        else if (navProgress <= 4.15) glowAlpha = 1.0;
                        else glowAlpha = Math.max(0.0, 1.0 - (navProgress - 4.15) / 0.3);
                    }
                    const pulse = 0.55 + 0.45 * Math.sin(elapsed * 2.8);
                    if (typeof craneGlowMat !== 'undefined' && craneGlowMat.uniforms && craneGlowMat.uniforms.uOpacity) {
                        craneGlowMat.uniforms.uOpacity.value = glowAlpha * pulse;
                    }
                }
            }

            renderer.render(scene, camera);

            // 水墨与朱砂拖尾粒子逐帧宣纸吸墨微扩散与淡出渲染
            if (inkCtx) {
                inkCtx.clearRect(0, 0, inkWidth, inkHeight);
                if (inkParticles.length > 0) {
                    for (let i = inkParticles.length - 1; i >= 0; i--) {
                        const p = inkParticles[i];
                        if (p.radius < p.maxRadius) {
                            p.radius += 0.18;
                        }
                        p.alpha -= p.decay;
                        if (p.alpha <= 0.005) {
                            inkParticles.splice(i, 1);
                            continue;
                        }
                        inkCtx.save();
                        inkCtx.beginPath();
                        inkCtx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                        inkCtx.fillStyle = `rgba(${p.color}, ${p.alpha})`;
                        inkCtx.fill();
                        inkCtx.restore();
                    }
                }
            }
        }

        animate();
    } // end initApp

    // 智能双模流式加载：网络环境下真实读取网络流进度；本地环境优雅平滑过渡
    if (typeof ELEMENT_ASSETS !== 'undefined') {
        initApp();
        finishLoading();
    } else if (window.location.protocol !== 'file:' && window.fetch) {
        fetch('elements_data.js')
            .then(response => {
                if (!response.ok) throw new Error('Fetch failed');
                const contentLength = response.headers.get('content-length');
                const total = contentLength ? parseInt(contentLength, 10) : 4150000;
                let loaded = 0;
                const reader = response.body.getReader();
                const chunks = [];

                function pump() {
                    return reader.read().then(({ done, value }) => {
                        if (done) {
                            const blob = new Blob(chunks, { type: 'application/javascript' });
                            const scriptUrl = URL.createObjectURL(blob);
                            const script = document.createElement('script');
                            script.src = scriptUrl;
                            script.onload = () => {
                                URL.revokeObjectURL(scriptUrl);
                                initApp();
                                finishLoading();
                            };
                            document.head.appendChild(script);
                            return;
                        }
                        chunks.push(value);
                        loaded += value.length;
                        const pct = Math.min(99, Math.floor((loaded / total) * 100));
                        updateProgress(pct);
                        return pump();
                    });
                }
                return pump();
            })
            .catch(err => {
                loadScriptFallback();
            });
    } else {
        loadScriptFallback();
    }

    function loadScriptFallback() {
        let p = 15;
        const timer = setInterval(() => {
            p += (95 - p) * 0.12;
            updateProgress(Math.floor(p));
        }, 120);

        const script = document.createElement('script');
        script.src = 'elements_data.js';
        script.onload = () => {
            clearInterval(timer);
            initApp();
            finishLoading();
        };
        script.onerror = () => {
            clearInterval(timer);
            initApp();
            finishLoading();
        };
        document.head.appendChild(script);
    }
