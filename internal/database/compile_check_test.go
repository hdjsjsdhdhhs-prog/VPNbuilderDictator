package database_test

import (
	"testing"

	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/database"
	"github.com/hdjsjsdhdhhs-prog/VPNbuilderDictator/internal/interfaces"
)

func TestCompileTimeInterfaceChecks(t *testing.T) {
	var _ interfaces.DatabaseService = (*database.Service)(nil)
}
