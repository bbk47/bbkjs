package bbk

type Server struct {
	ListenAddr    string `json:"listenAddr"`
	ListenPort    int    `json:"listenPort"`
	FillByte      int    `json:"fillByte"`
	LogLevel      string `json:"logLevel"`
	Method        string `json:"method"`
	Password      string `json:"password"`
	WebsocketPath string `json:"websocketPath"`
}

func (server Server) initialize() error {
	return nil;
}

func (server Server) Bootstrap() {
	
}

