# Appended after ExpressivePhoto.py. Fixed source; separately masked cloud layer.
class LayeredSpaceBackground(ExpressiveSpaceBackground):
    def __init__(self, image_path=IMAGE_PATH, config=EXPRESSIVE_CONFIG, flare_path=EXPRESSIVE_FLARE, layer=LAYER_CONFIG, paths=LAYER_PATHS, base_init=ExpressiveSpaceBackground.__init__):
        base_init(self,image_path,config,flare_path)
        self.layer_ready=False
        self.background=CreateTextureFromImage(paths[0].encode('utf-8'))
        self.foreground=CreateTextureFromImage(paths[1].encode('utf-8'))
        self.residual=CreateTextureFromImage(paths[2].encode('utf-8'))
        self.limits=tuple(layer['maxMotionPixels'])
        cols,rows,weights=layer['grid'];self.points=[];self.indices=[]
        for y in range(rows):
            for x in range(cols): self.points.append((float(x)/(cols-1),float(y)/(rows-1),weights[y*cols+x]))
        for y in range(rows-1):
            for x in range(cols-1):
                a=y*cols+x;self.indices.extend((a,a+1,a+cols,a+1,a+cols+1,a+cols))
        self.mesh=VertexList([ss_XY,ss_TexXY],ss_ChangesEachUse,len(self.indices))

    def draw_photo(self,ext,u,v,base_photo=ExpressiveSpaceBackground.draw_photo):
        self.layer_ready=all(GetTextureSize(t) for t in (self.background,self.foreground,self.residual))
        amount=min(1.0,.85*self.levels[0]+.65*self.kick)
        if not self.layer_ready or amount<.0001:
            return base_photo(self,ext,u,v)
        self.quad.SetTexture(self.background,RGBA(1,1,1,1));self.quad.DrawTriangles(0,1)
        points=[];self.displacement=0.0
        for x,y,w in self.points:
            dx=self.limits[0]*amount*w*math.sin(self.phase*.9+y*5+x*2)
            dy=self.limits[1]*amount*w*math.sin(self.phase*.7-x*4+y*2)
            self.displacement=max(self.displacement,math.sqrt(dx*dx+dy*dy))
            points.append(((2*(x+dx/3840)-1)*ext[0]/u,(1-2*(y+dy/2160))*ext[1]/v,x,y))
        for i,k in enumerate(self.indices):
            q=self.mesh[i];q[0],q[1],q[2],q[3]=points[k]
        self.mesh.SetTexture(self.foreground,RGBA(1,1,1,1));self.mesh.DrawTriangles(0,-1,3)
        SetBlendMode(ss_LightBlend)
        self.quad.SetTexture(self.residual,RGBA(1,1,1,1));self.quad.DrawTriangles(0,1)
        SetBlendMode(ss_AlphaBlend)

SetDrawClass(LayeredSpaceBackground)
