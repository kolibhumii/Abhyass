(function () {
  const tabs = document.querySelectorAll(".tab-btn");
  const tabsContainer = document.querySelector(".auth-tabs");
  const loginForm = document.getElementById("loginForm");
  const signupFlow = document.getElementById("signupFlow");
  const studentSignupForm = document.getElementById("studentSignupForm");
  const teacherSignupForm = document.getElementById("teacherSignupForm");
  const signupRoleView = document.getElementById("signupRoleView");
  const switchLinks = document.querySelectorAll(".switch-link");
  const roleButtons = document.querySelectorAll("[data-signup-role]");
  const roleBackButtons = document.querySelectorAll("[data-signup-back]");
  const alertBox = document.getElementById("authAlert");

  const signupPanels = {
    student: studentSignupForm,
    teacher: teacherSignupForm,
  };

  const forms = [loginForm, studentSignupForm, teacherSignupForm].filter(Boolean);

  function resetFormState(form) {
    if (!form) return;
    form.classList.remove("was-validated");
    form.reset();
  }

  function resetPasswordToggles() {
    document.querySelectorAll(".btn-toggle-pass").forEach((btn) => {
      const input = document.getElementById(btn.dataset.target);
      const icon = btn.querySelector("i");

      if (!input || !icon) return;

      input.type = "password";
      icon.classList.remove("bi-eye-slash");
      icon.classList.add("bi-eye");
    });
  }

  function showSignupPanel(role = "") {
    signupRoleView.classList.toggle("d-none", Boolean(role));

    Object.entries(signupPanels).forEach(([key, panel]) => {
      if (!panel) return;
      panel.classList.toggle("d-none", key !== role);
      if (key !== role) {
        panel.classList.remove("was-validated");
      }
    });
  }

  function resetSignupFlow() {
    Object.values(signupPanels).forEach((form) => resetFormState(form));
    showSignupPanel("");
  }

  function showForm(target) {
    tabs.forEach((tab) =>
      tab.classList.toggle("active", tab.dataset.target === target)
    );
    tabsContainer.classList.toggle("signup-active", target === "signup");

    loginForm.classList.toggle("d-none", target !== "login");
    signupFlow.classList.toggle("d-none", target !== "signup");

    resetFormState(loginForm);
    resetSignupFlow();
    resetPasswordToggles();
    alertBox.classList.add("d-none");
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => showForm(tab.dataset.target));
  });

  switchLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showForm(link.dataset.target);
    });
  });

  roleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      showSignupPanel(button.dataset.signupRole);
    });
  });

  roleBackButtons.forEach((button) => {
    button.addEventListener("click", () => {
      resetSignupFlow();
      resetPasswordToggles();
    });
  });

  document.querySelectorAll(".btn-toggle-pass").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      const icon = btn.querySelector("i");

      if (!input || !icon) return;

      if (input.type === "password") {
        input.type = "text";
        icon.classList.replace("bi-eye", "bi-eye-slash");
      } else {
        input.type = "password";
        icon.classList.replace("bi-eye-slash", "bi-eye");
      }
    });
  });

  forms.forEach((form) => {
    form.addEventListener("submit", (e) => {
      if (!form.checkValidity()) {
        e.preventDefault();
        e.stopPropagation();
        form.classList.add("was-validated");
      }
    });
  });
})();
